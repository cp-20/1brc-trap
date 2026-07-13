package main

import (
	"bufio"
	"encoding/binary"
	"flag"
	"fmt"
	"io"
	"math/bits"
	"os"
	"runtime"
	"runtime/pprof"
	"sort"
	"strconv"
	"syscall"
	"time"
	"unsafe"

	progressbar "github.com/cp-20/1blc-trap/internal/progress"
)

const (
	defaultMapCap    = 1 << 15
	defaultBufferLen = 4 << 20
)

type stats struct {
	messages uint64
	totalLen uint64
	stamps   uint64
	minLen   uint32
	maxLen   uint32
}

type flatMap struct {
	entries []mapEntry
	aggs    []channelAgg
	size    int
}

type mapEntry struct {
	key  string
	hash uint64
	id   uint32
}

type outputEntry struct {
	key string
	id  uint32
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

func main() {
	input := flag.String("i", "", "input CSV file path; required for mmap")
	output := flag.String("o", "", "output file path; default is stdout")
	threads := flag.Int("t", runtime.NumCPU(), "worker thread count")
	profileEnabled := flag.Bool("profile", false, "print timing profile to stderr")
	showProgress := flag.Bool("progress", false, "print input progress to stderr")
	cpuProfile := flag.String("cpuprofile", "", "write CPU profile to file")
	flag.Parse()

	if *input == "" {
		exitWithError("optimized Go analyzer requires -i")
	}
	if *threads <= 0 {
		exitWithError("thread count must be greater than 0")
	}
	runtime.GOMAXPROCS(*threads)
	if *cpuProfile != "" {
		file, err := os.Create(*cpuProfile)
		if err != nil {
			exitWithError(fmt.Sprintf("failed to create CPU profile: %v", err))
		}
		if err := pprof.StartCPUProfile(file); err != nil {
			_ = file.Close()
			exitWithError(fmt.Sprintf("failed to start CPU profile: %v", err))
		}
		defer func() {
			pprof.StopCPUProfile()
			_ = file.Close()
		}()
	}

	var p profile
	mmapStart := time.Now()
	mapped, err := openMmap(*input)
	if err != nil {
		exitWithError(err.Error())
	}
	defer mapped.close()
	if *profileEnabled {
		p.mmapSeconds = secondsSince(mmapStart)
	}

	var bar *progressbar.Bar
	var report func(int64)
	if *showProgress {
		bar = progressbar.New(os.Stderr, int64(len(mapped.data)), "bytes")
		report = bar.Add
	}
	result, err := analyzeMemory(mapped.data, *threads, profileSink(*profileEnabled, &p), report)
	if bar != nil {
		bar.Done(err == nil)
	}
	if err != nil {
		exitWithError(err.Error())
	}

	writer, closeWriter, err := openOutput(*output)
	if err != nil {
		exitWithError(err.Error())
	}
	defer closeWriter()

	outputStart := time.Now()
	if err := writeResult(writer, result); err != nil {
		exitWithError(err.Error())
	}
	if *profileEnabled {
		p.outputSeconds = secondsSince(outputStart)
		cleanupStart := time.Now()
		mapped.close()
		p.cleanupSeconds = secondsSince(cleanupStart)
		fmt.Fprintf(
			os.Stderr,
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
		return newFlatMap(defaultMapCap), nil
	}

	locals := make([]*flatMap, len(chunks))
	workerSeconds := make([]float64, len(chunks))
	done := make(chan int, len(chunks))

	workersStart := time.Now()
	for i, c := range chunks {
		go func(i int, c chunk) {
			start := time.Now()
			locals[i] = analyzeChunk(data[c.begin:c.end], report)
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
	merged := newFlatMap(defaultMapCap)
	for _, local := range locals {
		merged.mergeFrom(local)
	}
	if p != nil {
		p.mergeSeconds = secondsSince(mergeStart)
		p.groups = merged.groups()
	}
	return merged, nil
}

func analyzeChunk(data []byte, report func(int64)) *flatMap {
	m := newFlatMap(defaultMapCap)
	reported := 0
	nextReport := 4 * 1024 * 1024
	for i := 0; i < len(data); {
		if data[i] == '\n' || data[i] == '\r' {
			i++
			continue
		}
		if i+10 >= len(data) {
			break
		}
		timestamp := uint32(data[i] - '0')
		timestamp = timestamp*10 + uint32(data[i+1]-'0')
		timestamp = timestamp*10 + uint32(data[i+2]-'0')
		timestamp = timestamp*10 + uint32(data[i+3]-'0')
		timestamp = timestamp*10 + uint32(data[i+4]-'0')
		timestamp = timestamp*10 + uint32(data[i+5]-'0')
		timestamp = timestamp*10 + uint32(data[i+6]-'0')
		timestamp = timestamp*10 + uint32(data[i+7]-'0')
		timestamp = timestamp*10 + uint32(data[i+8]-'0')
		timestamp = timestamp*10 + uint32(data[i+9]-'0')
		month := monthIndexFromUnixTimestamp(timestamp)
		p := i + 11

		channelBegin := p
		for data[p] != ',' {
			p++
		}
		channel := unsafe.String(&data[channelBegin], p-channelBegin)
		channelHash := hashBytes(data[channelBegin:p])
		p++
		messageLength := uint32(0)
		for data[p] != ',' {
			messageLength = messageLength*10 + uint32(data[p]-'0')
			p++
		}
		p++

		stampCount := uint32(0)
		for p < len(data) {
			c := data[p]
			if c < '0' || c > '9' {
				break
			}
			stampCount = stampCount*10 + uint32(c-'0')
			p++
		}
		for p < len(data) && data[p] != '\n' {
			p++
		}
		if p < len(data) {
			p++
		}

		m.add(channel, channelHash, month, messageLength, stampCount)
		i = p
		if report != nil && i >= nextReport {
			report(int64(i - reported))
			reported = i
			nextReport = i + 4*1024*1024
		}
	}
	if report != nil && reported < len(data) {
		report(int64(len(data) - reported))
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

func newFlatMap(capacity int) *flatMap {
	c := 1
	for c < capacity {
		c <<= 1
	}
	return &flatMap{
		entries: make([]mapEntry, c),
		aggs:    make([]channelAgg, 0, c/2),
	}
}

func (m *flatMap) add(key string, hash uint64, month int, messageLength, stampCount uint32) {
	if (m.size+1)*10 >= len(m.entries)*7 {
		m.rehash(len(m.entries) * 2)
	}
	e := m.findOrInsert(key, hash)
	id := e.id
	s := &m.aggs[id].months[month]
	if s.messages == 0 {
		*s = stats{
			messages: 1,
			totalLen: uint64(messageLength),
			stamps:   uint64(stampCount),
			minLen:   messageLength,
			maxLen:   messageLength,
		}
		return
	}
	s.messages++
	s.totalLen += uint64(messageLength)
	s.stamps += uint64(stampCount)
	if messageLength < s.minLen {
		s.minLen = messageLength
	}
	if messageLength > s.maxLen {
		s.maxLen = messageLength
	}
}

func (m *flatMap) findOrInsert(key string, hash uint64) *mapEntry {
	mask := uint64(len(m.entries) - 1)
	index := hash & mask
	for {
		e := &m.entries[index]
		if e.key == "" {
			e.key = key
			e.hash = hash
			e.id = uint32(len(m.aggs))
			m.aggs = append(m.aggs, channelAgg{})
			m.size++
			return e
		}
		if e.hash == hash && e.key == key {
			return e
		}
		index = (index + 1) & mask
	}
}

func (m *flatMap) mergeFrom(other *flatMap) {
	for i := range other.entries {
		e := &other.entries[i]
		if e.key == "" {
			continue
		}
		if (m.size+1)*10 >= len(m.entries)*7 {
			m.rehash(len(m.entries) * 2)
		}
		dst := m.findOrInsert(e.key, e.hash)
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
		if e.key != "" {
			m.insertRehashed(*e)
		}
	}
}

func (m *flatMap) insertRehashed(entry mapEntry) {
	mask := uint64(len(m.entries) - 1)
	index := entry.hash & mask
	for m.entries[index].key != "" {
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
		if e.key != "" {
			entries = append(entries, outputEntry{key: e.key, id: e.id})
		}
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].key < entries[j].key
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
			line = append(line, e.key...)
			line = append(line, ',')
			line = append(line, monthLabels[month]...)
			line = append(line, '=')
			line = strconv.AppendUint(line, uint64(s.minLen), 10)
			line = append(line, '/')
			line = strconv.AppendFloat(line, float64(s.totalLen)/float64(s.messages), 'f', 2, 64)
			line = append(line, '/')
			line = strconv.AppendUint(line, uint64(s.maxLen), 10)
			line = append(line, '/')
			line = strconv.AppendUint(line, s.messages, 10)
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

func openOutput(path string) (io.Writer, func(), error) {
	if path == "" {
		return os.Stdout, func() {}, nil
	}

	file, err := os.Create(path)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create output: %w", err)
	}
	return file, func() {
		_ = file.Close()
	}, nil
}

func hashBytes(data []byte) uint64 {
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
	return mix64(h ^ uint64(n)*0xd6e8feb86659fd93)
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

func exitWithError(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
