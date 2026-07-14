package expected

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"math/bits"
	"os"
	"runtime"
	"sort"
	"strconv"
	"syscall"
	"time"
)

const (
	defaultMapCap    = 1 << 15
	defaultBufferLen = 4 << 20
)

type stats struct {
	totalLen uint64
	stamps   uint64
	messages uint32
	minLen   uint16
	maxLen   uint16
}

type flatMap struct {
	data    []byte
	entries []mapEntry
	aggs    []channelAgg
	size    int
}

type mapEntry struct {
	pos uint64
	len uint32
	id  uint16
	tag uint16
}

type outputEntry struct {
	pos uint64
	len uint32
	id  uint16
}

type channelAgg struct {
	months [12]stats
}

type chunk struct {
	begin int
	end   int
}

type profile struct {
	mmapSeconds       float64
	splitSeconds      float64
	workerWallSeconds float64
	workerSumSeconds  float64
	mergeSeconds      float64
	outputSeconds     float64
	cleanupSeconds    float64
	chunks            int
	groups            int
}

var monthLabels = [12]string{
	"2027-01",
	"2027-02",
	"2027-03",
	"2027-04",
	"2027-05",
	"2027-06",
	"2027-07",
	"2027-08",
	"2027-09",
	"2027-10",
	"2027-11",
	"2027-12",
}

var monthStartUnix = [13]int64{
	1798761600,
	1801440000,
	1803859200,
	1806537600,
	1809129600,
	1811808000,
	1814400000,
	1817078400,
	1819756800,
	1822348800,
	1825027200,
	1827619200,
	1830297600,
}

var monthByDay = func() [365]uint8 {
	var result [365]uint8
	month := 0
	for day := range result {
		timestamp := monthStartUnix[0] + int64(day*86400)
		if timestamp >= monthStartUnix[month+1] {
			month++
		}
		result[day] = uint8(month)
	}
	return result
}()

type mmapFile struct {
	file *os.File
	data []byte
}

type Options struct {
	Threads  int
	Profile  bool
	Log      io.Writer
	Progress func(int64)
}

func Generate(input string, output io.Writer, options Options) error {
	if options.Threads <= 0 {
		return fmt.Errorf("thread count must be greater than 0")
	}
	previousProcs := runtime.GOMAXPROCS(options.Threads)
	defer runtime.GOMAXPROCS(previousProcs)
	log := options.Log
	if log == nil {
		log = io.Discard
	}

	var p profile
	mmapStart := time.Now()
	mapped, err := openMmap(input)
	if err != nil {
		return err
	}
	defer mapped.close()
	if options.Profile {
		p.mmapSeconds = secondsSince(mmapStart)
	}

	result, err := analyzeMemory(mapped.data, options.Threads, profileSink(options.Profile, &p), options.Progress)
	if err != nil {
		return err
	}

	outputStart := time.Now()
	if err := writeResult(output, result); err != nil {
		return err
	}
	if options.Profile {
		p.outputSeconds = secondsSince(outputStart)
		cleanupStart := time.Now()
		mapped.close()
		p.cleanupSeconds = secondsSince(cleanupStart)
		fmt.Fprintf(
			log,
			"profile mmap=%.6f split=%.6f workers_wall=%.6f workers_sum=%.6f merge=%.6f output=%.6f cleanup=%.6f chunks=%d groups=%d\n",
			p.mmapSeconds,
			p.splitSeconds,
			p.workerWallSeconds,
			p.workerSumSeconds,
			p.mergeSeconds,
			p.outputSeconds,
			p.cleanupSeconds,
			p.chunks,
			p.groups,
		)
	}
	return nil
}

func profileSink(enabled bool, p *profile) *profile {
	if !enabled {
		return nil
	}
	return p
}

func analyzeMemory(data []byte, threads int, p *profile, report func(int64)) (*flatMap, error) {
	headerEnd := indexByte(data, 0, len(data), '\n')
	if headerEnd < 0 {
		return nil, fmt.Errorf("failed to read CSV header")
	}
	if string(data[:headerEnd]) != "unix_timestamp,channel_path,message_length,stamp_count" {
		return nil, fmt.Errorf("unsupported CSV header: %q", data[:headerEnd])
	}

	splitStart := time.Now()
	chunks := splitChunks(data, headerEnd+1, len(data), threads)
	if p != nil {
		p.splitSeconds = secondsSince(splitStart)
		p.chunks = len(chunks)
	}
	if len(chunks) == 0 {
		return newFlatMap(data, defaultMapCap), nil
	}

	locals := make([]*flatMap, len(chunks))
	workerSeconds := make([]float64, len(chunks))
	done := make(chan int, len(chunks))

	workersStart := time.Now()
	for i, c := range chunks {
		go func(i int, c chunk) {
			start := time.Now()
			locals[i] = analyzeChunk(data, c.begin, c.end, report)
			workerSeconds[i] = secondsSince(start)
			done <- i
		}(i, c)
	}
	for range chunks {
		<-done
	}
	if p != nil {
		p.workerWallSeconds = secondsSince(workersStart)
		for _, seconds := range workerSeconds {
			p.workerSumSeconds += seconds
		}
	}

	mergeStart := time.Now()
	merged := newFlatMap(data, defaultMapCap)
	for _, local := range locals {
		merged.mergeFrom(local)
	}
	if p != nil {
		p.mergeSeconds = secondsSince(mergeStart)
		p.groups = merged.groups()
	}
	return merged, nil
}

func analyzeChunk(data []byte, begin, end int, report func(int64)) *flatMap {
	m := newFlatMap(data, defaultMapCap)
	reported := 0
	nextReport := 4 * 1024 * 1024
	for i := begin; i < end; {
		if data[i] == '\n' || data[i] == '\r' {
			i++
			continue
		}
		if i+10 >= end {
			break
		}
		x := binary.LittleEndian.Uint64(data[i:]) & 0x0f0f0f0f0f0f0f0f
		x = (x&0x000f000f000f000f)*10 + ((x >> 8) & 0x000f000f000f000f)
		x = (x&0x000000ff000000ff)*100 + ((x >> 16) & 0x000000ff000000ff)
		first8 := uint32(x)*10000 + uint32(x>>32)
		timestamp := first8*100 + uint32(data[i+8]-'0')*10 + uint32(data[i+9]-'0')
		month := monthIndexFromUnixTimestamp(timestamp)
		p := i + 11

		channelBegin := p
		p += bytes.IndexByte(data[p:end], ',')
		channelLen := uint32(p - channelBegin)
		channelHash := hashBytes(data[channelBegin:p])
		p++
		messageLength := uint32(data[p] - '0')
		p++
		for data[p] != ',' {
			messageLength = messageLength*10 + uint32(data[p]-'0')
			p++
		}
		p++

		stampCount := uint32(data[p] - '0')
		p++
		for data[p] != '\n' {
			stampCount = stampCount*10 + uint32(data[p]-'0')
			p++
		}
		p++

		m.add(uint64(channelBegin), channelLen, channelHash, month, messageLength, stampCount)
		i = p
		processed := i - begin
		if report != nil && processed >= nextReport {
			report(int64(processed - reported))
			reported = processed
			nextReport = processed + 4*1024*1024
		}
	}
	if report != nil && reported < end-begin {
		report(int64(end - begin - reported))
	}
	return m
}

func monthIndexFromUnixTimestamp(timestamp uint32) int {
	day := (timestamp - uint32(monthStartUnix[0])) / 86400
	return int(monthByDay[day])
}

func splitChunks(data []byte, begin, end, threads int) []chunk {
	if begin >= end {
		return nil
	}
	bytes := end - begin
	maxThreads := bytes/4096 + 1
	if threads > maxThreads {
		threads = maxThreads
	}
	if threads < 1 {
		threads = 1
	}

	chunks := make([]chunk, 0, threads)
	chunkBegin := begin
	for i := 1; i < threads; i++ {
		target := begin + bytes*i/threads
		newline := indexByte(data, target, end, '\n')
		chunkEnd := end
		if newline >= 0 {
			chunkEnd = newline + 1
		}
		if chunkBegin < chunkEnd {
			chunks = append(chunks, chunk{begin: chunkBegin, end: chunkEnd})
		}
		chunkBegin = chunkEnd
	}
	if chunkBegin < end {
		chunks = append(chunks, chunk{begin: chunkBegin, end: end})
	}
	return chunks
}

func newFlatMap(data []byte, capacity int) *flatMap {
	c := 1
	for c < capacity {
		c <<= 1
	}
	return &flatMap{
		data:    data,
		entries: make([]mapEntry, c),
		aggs:    make([]channelAgg, 0, c/2),
	}
}

func (m *flatMap) add(pos uint64, length, hash uint32, month int, messageLength, stampCount uint32) {
	if (m.size+1)*10 >= len(m.entries)*7 {
		m.rehash(len(m.entries) * 2)
	}
	e := m.findOrInsert(pos, length, hash)
	id := e.id
	s := &m.aggs[id].months[month]
	if s.messages == 0 {
		*s = stats{
			messages: 1,
			totalLen: uint64(messageLength),
			stamps:   uint64(stampCount),
			minLen:   uint16(messageLength),
			maxLen:   uint16(messageLength),
		}
		return
	}
	s.messages++
	s.totalLen += uint64(messageLength)
	s.stamps += uint64(stampCount)
	if uint16(messageLength) < s.minLen {
		s.minLen = uint16(messageLength)
	}
	if uint16(messageLength) > s.maxLen {
		s.maxLen = uint16(messageLength)
	}
}

func (m *flatMap) findOrInsert(pos uint64, length, hash uint32) *mapEntry {
	mask := uint32(len(m.entries) - 1)
	index := hash & mask
	tag := uint16(hash >> 16)
	for {
		e := &m.entries[index]
		if e.len == 0 {
			e.pos = pos
			e.len = length
			e.id = uint16(len(m.aggs))
			e.tag = tag
			m.aggs = append(m.aggs, channelAgg{})
			m.size++
			return e
		}
		if e.tag == tag && e.len == length && bytes.Equal(
			m.data[e.pos:e.pos+uint64(e.len)],
			m.data[pos:pos+uint64(length)],
		) {
			return e
		}
		index = (index + 1) & mask
	}
}

func (m *flatMap) mergeFrom(other *flatMap) {
	for i := range other.entries {
		e := &other.entries[i]
		if e.len == 0 {
			continue
		}
		if (m.size+1)*10 >= len(m.entries)*7 {
			m.rehash(len(m.entries) * 2)
		}
		hash := hashBytes(m.data[e.pos : e.pos+uint64(e.len)])
		dst := m.findOrInsert(e.pos, e.len, hash)
		srcAgg := &other.aggs[e.id]
		dstAgg := &m.aggs[dst.id]
		for month := range srcAgg.months {
			incoming := srcAgg.months[month]
			if incoming.messages == 0 {
				continue
			}
			s := &dstAgg.months[month]
			if s.messages == 0 {
				*s = incoming
				continue
			}
			s.messages += incoming.messages
			s.totalLen += incoming.totalLen
			s.stamps += incoming.stamps
			if incoming.minLen < s.minLen {
				s.minLen = incoming.minLen
			}
			if incoming.maxLen > s.maxLen {
				s.maxLen = incoming.maxLen
			}
		}
	}
}

func (m *flatMap) rehash(capacity int) {
	old := m.entries
	m.entries = make([]mapEntry, capacity)
	m.size = 0
	for i := range old {
		e := &old[i]
		if e.len != 0 {
			m.insertRehashed(*e)
		}
	}
}

func (m *flatMap) insertRehashed(entry mapEntry) {
	hash := hashBytes(m.data[entry.pos : entry.pos+uint64(entry.len)])
	mask := uint32(len(m.entries) - 1)
	index := hash & mask
	for m.entries[index].len != 0 {
		index = (index + 1) & mask
	}
	m.entries[index] = entry
	m.size++
}

func (m *flatMap) groups() int {
	count := 0
	for i := range m.aggs {
		for month := range m.aggs[i].months {
			if m.aggs[i].months[month].messages != 0 {
				count++
			}
		}
	}
	return count
}

func writeResult(w io.Writer, m *flatMap) error {
	entries := make([]outputEntry, 0, m.size)
	for i := range m.entries {
		e := &m.entries[i]
		if e.len != 0 {
			entries = append(entries, outputEntry{pos: e.pos, len: e.len, id: e.id})
		}
	}
	sort.Slice(entries, func(i, j int) bool {
		a, b := &entries[i], &entries[j]
		return bytes.Compare(m.data[a.pos:a.pos+uint64(a.len)], m.data[b.pos:b.pos+uint64(b.len)]) < 0
	})

	buffered := bufio.NewWriterSize(w, defaultBufferLen)
	line := make([]byte, 0, 96)
	for i := range entries {
		e := &entries[i]
		agg := &m.aggs[e.id]
		for month := range agg.months {
			s := &agg.months[month]
			if s.messages == 0 {
				continue
			}
			line = line[:0]
			line = append(line, m.data[e.pos:e.pos+uint64(e.len)]...)
			line = append(line, ',')
			line = append(line, monthLabels[month]...)
			line = append(line, '=')
			line = strconv.AppendUint(line, uint64(s.minLen), 10)
			line = append(line, '/')
			line = strconv.AppendFloat(line, float64(s.totalLen)/float64(s.messages), 'f', 2, 64)
			line = append(line, '/')
			line = strconv.AppendUint(line, uint64(s.maxLen), 10)
			line = append(line, '/')
			line = strconv.AppendUint(line, uint64(s.messages), 10)
			line = append(line, '/')
			line = strconv.AppendUint(line, s.stamps, 10)
			line = append(line, '\n')
			if _, err := buffered.Write(line); err != nil {
				return err
			}
		}
	}
	return buffered.Flush()
}

func openMmap(path string) (*mmapFile, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("failed to open input: %w", err)
	}

	stat, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("failed to stat input: %w", err)
	}
	if stat.Size() <= 0 {
		_ = file.Close()
		return nil, fmt.Errorf("input is empty")
	}

	data, err := syscall.Mmap(int(file.Fd()), 0, int(stat.Size()), syscall.PROT_READ, syscall.MAP_PRIVATE)
	if err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("failed to mmap input: %w", err)
	}
	_ = syscall.Madvise(data, syscall.MADV_SEQUENTIAL)

	return &mmapFile{file: file, data: data}, nil
}

func (m *mmapFile) close() {
	if m.data != nil {
		_ = syscall.Munmap(m.data)
		m.data = nil
	}
	if m.file != nil {
		_ = m.file.Close()
		m.file = nil
	}
}

func hashBytes(data []byte) uint32 {
	n := len(data)
	var a, b, c uint64
	switch {
	case n >= 24:
		a = binary.LittleEndian.Uint64(data)
		b = binary.LittleEndian.Uint64(data[n/2-4:])
		c = binary.LittleEndian.Uint64(data[n-8:])
	case n >= 16:
		a = binary.LittleEndian.Uint64(data)
		c = binary.LittleEndian.Uint64(data[n-8:])
	case n >= 8:
		a = binary.LittleEndian.Uint64(data)
		c = binary.LittleEndian.Uint64(data[n-8:])
	default:
		for i, value := range data {
			a |= uint64(value) << (8 * i)
		}
	}
	h := a*0x9e3779b185ebca87 ^ bits.RotateLeft64(b, 21) ^ bits.RotateLeft64(c, 43)
	return uint32(mix64(h ^ uint64(n)*0xd6e8feb86659fd93))
}

func mix64(x uint64) uint64 {
	x ^= x >> 30
	x *= 0xbf58476d1ce4e5b9
	x ^= x >> 27
	x *= 0x94d049bb133111eb
	x ^= x >> 31
	return x
}

func indexByte(data []byte, begin, end int, needle byte) int {
	for i := begin; i < end; i++ {
		if data[i] == needle {
			return i
		}
	}
	return -1
}

func secondsSince(start time.Time) float64 {
	return time.Since(start).Seconds()
}
