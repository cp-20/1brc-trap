package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"math"
	"math/rand"
	"os"
	"sort"
	"strconv"
	"time"
)

const (
	defaultRows       = 10_000_000
	defaultChannels   = 10_000
	defaultBufferSize = 4 * 1024 * 1024
	maxChannelDepth   = 5
)

type dayWeight struct {
	day    time.Time
	weight float64
}

type channelProfile struct {
	path string
}

func main() {
	rows := flag.Int("n", defaultRows, "number of messages to generate")
	channelCount := flag.Int("channels", defaultChannels, "number of distinct channels")
	output := flag.String("o", "", "output file path; default is stdout")
	seed := flag.Int64("seed", time.Now().UnixNano(), "random seed")
	bufferSize := flag.Int("buffer", defaultBufferSize, "output buffer size in bytes")
	flag.Parse()

	if *rows < 0 {
		exit("n must be greater than or equal to 0")
	}
	if *channelCount <= 0 {
		exit("channels must be greater than 0")
	}
	if *bufferSize <= 0 {
		exit("buffer must be greater than 0")
	}

	writer, closeWriter, err := openWriter(*output)
	if err != nil {
		exit(err.Error())
	}
	defer closeWriter()

	r := rand.New(rand.NewSource(*seed))
	g := newGenerator(r, *channelCount)
	if err := g.write(writer, *rows, *bufferSize); err != nil {
		exit(err.Error())
	}
}

type generator struct {
	r           *rand.Rand
	days        []dayWeight
	dayTotals   []float64
	dayTotal    float64
	hourTotals  []float64
	hourTotal   float64
	channels    []channelProfile
	channelZipf *rand.Zipf
}

func newGenerator(r *rand.Rand, channelCount int) *generator {
	paths := buildChannelPaths(channelCount)
	channels := make([]channelProfile, channelCount)
	for i := range channels {
		channels[i] = channelProfile{
			path: paths[i],
		}
	}

	days, dayTotals, dayTotal := buildDayWeights()
	hourTotals, hourTotal := buildHourWeights()

	return &generator{
		r:           r,
		days:        days,
		dayTotals:   dayTotals,
		dayTotal:    dayTotal,
		hourTotals:  hourTotals,
		hourTotal:   hourTotal,
		channels:    channels,
		channelZipf: rand.NewZipf(r, 1.09, 1, uint64(channelCount-1)),
	}
}

func (g *generator) write(w io.Writer, rows, bufferSize int) error {
	buffered := bufio.NewWriterSize(w, bufferSize)
	if _, err := buffered.WriteString("unix_timestamp,channel_path,message_length,stamp_count\n"); err != nil {
		return err
	}

	line := make([]byte, 0, 96)
	for i := 0; i < rows; i++ {
		line = g.appendRow(line[:0])
		if _, err := buffered.Write(line); err != nil {
			return err
		}
	}

	return buffered.Flush()
}

func (g *generator) appendRow(line []byte) []byte {
	channel := &g.channels[g.channelZipf.Uint64()]

	line = strconv.AppendInt(line, g.pickTimestamp().Unix(), 10)
	line = append(line, ',')
	line = append(line, channel.path...)
	line = append(line, ',')
	line = strconv.AppendInt(line, int64(g.pickMessageLength()), 10)
	line = append(line, ',')
	line = strconv.AppendInt(line, int64(g.pickStampCount()), 10)
	line = append(line, '\n')
	return line
}

func (g *generator) pickTimestamp() time.Time {
	day := g.days[weightedIndex(g.dayTotals, g.r.Float64()*g.dayTotal)].day
	hour := weightedIndex(g.hourTotals, g.r.Float64()*g.hourTotal)
	minute := g.r.Intn(60)
	second := g.r.Intn(60)
	millisecond := g.r.Intn(1000)
	return day.Add(time.Duration(hour)*time.Hour +
		time.Duration(minute)*time.Minute +
		time.Duration(second)*time.Second +
		time.Duration(millisecond)*time.Millisecond)
}

func (g *generator) pickMessageLength() int {
	x := math.Exp(math.Log(100) + 0.55*0.55 + g.r.NormFloat64()*0.55)
	if g.r.Float64() < 0.04 {
		x += 220 * math.Pow(1-g.r.Float64(), -0.70)
	}

	length := int(math.Round(x))
	if length < 1 {
		return 1
	}
	if length > 12000 {
		return 12000
	}
	return length
}

func (g *generator) pickStampCount() int {
	p := g.r.Float64()
	switch {
	case p < 0.62:
		return 0
	case p < 0.84:
		return 1 + g.r.Intn(3)
	case p < 0.96:
		return 4 + geometric(g.r, 0.38)
	default:
		return 12 + geometric(g.r, 0.13)
	}
}

func buildDayWeights() ([]dayWeight, []float64, float64) {
	start := time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)
	days := make([]dayWeight, 365)
	totals := make([]float64, 365)
	total := 0.0

	for i := range days {
		day := start.AddDate(0, 0, i)
		weight := termWeight(day) * weekdayWeight(day) * holidayWeight(day)
		days[i] = dayWeight{day: day, weight: weight}
		total += weight
		totals[i] = total
	}

	return days, totals, total
}

func buildHourWeights() ([]float64, float64) {
	totals := make([]float64, 24)
	total := 0.0
	for hour := range totals {
		h := float64(hour)
		weight := 0.18
		if hour < 6 {
			weight += 1.45 * math.Pow((6.0-h)/6.0, 1.25)
		} else {
			weight += 1.85 * math.Pow((h-6.0)/18.0, 1.35)
		}
		weight += 0.15 * math.Exp(-math.Pow(h-12.0, 2)/(2*2.5*2.5))
		total += weight
		totals[hour] = total
	}
	return totals, total
}

func termWeight(day time.Time) float64 {
	month := day.Month()
	date := day.Day()

	if month == time.February || month == time.March {
		return 0.52
	}
	if month == time.August || month == time.September {
		return 0.45
	}
	if month == time.January && date <= 7 {
		return 0.55
	}
	if month == time.December && date >= 24 {
		return 0.65
	}
	return 1.0
}

func weekdayWeight(day time.Time) float64 {
	switch day.Weekday() {
	case time.Saturday:
		return 0.66
	case time.Sunday:
		return 0.52
	default:
		return 1.0
	}
}

func holidayWeight(day time.Time) float64 {
	if _, ok := japanHolidays2027[day.Format("2006-01-02")]; ok {
		return 0.50
	}
	return 1.0
}

var japanHolidays2027 = map[string]struct{}{
	"2027-01-01": {},
	"2027-01-11": {},
	"2027-02-11": {},
	"2027-02-23": {},
	"2027-03-21": {},
	"2027-03-22": {},
	"2027-04-29": {},
	"2027-05-03": {},
	"2027-05-04": {},
	"2027-05-05": {},
	"2027-07-19": {},
	"2027-08-11": {},
	"2027-09-20": {},
	"2027-09-23": {},
	"2027-10-11": {},
	"2027-11-03": {},
	"2027-11-23": {},
}

func weightedIndex(totals []float64, needle float64) int {
	return sort.Search(len(totals), func(i int) bool {
		return totals[i] >= needle
	})
}

func geometric(r *rand.Rand, stopProbability float64) int {
	count := 0
	for r.Float64() > stopProbability {
		count++
		if count >= 200 {
			return count
		}
	}
	return count
}

func openWriter(path string) (io.Writer, func(), error) {
	if path == "" {
		return os.Stdout, func() {}, nil
	}

	file, err := os.Create(path)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create output file: %w", err)
	}

	return file, func() {
		_ = file.Close()
	}, nil
}

func exit(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}

func buildChannelPaths(count int) []string {
	words := [...][]string{
		{"team", "project", "club", "lab", "class", "event", "help", "bot", "game", "music", "art", "book", "photo", "video", "news", "data", "infra", "design", "staff", "admin", "sales", "ops", "home", "work"},
		{"core", "dev", "web", "app", "api", "mobile", "server", "client", "data", "search", "auth", "chat", "voice", "image", "build", "test", "docs", "plan", "meet", "room", "topic", "note", "task", "release", "support", "random", "social", "media", "study", "learn", "write", "read"},
		{"main", "alpha", "beta", "green", "blue", "red", "gold", "fast", "slow", "daily", "weekly", "night", "idea", "bug", "fix", "review", "deploy", "log", "alert", "queue", "cache", "store", "index", "job", "skill", "tool", "link", "feed", "draft", "memo", "board", "map"},
		{"open", "close", "new", "old", "hot", "cold", "north", "south", "east", "west", "local", "global", "public", "private", "small", "large", "light", "dark", "early", "late", "first", "last", "next", "back", "front", "inner", "outer", "quiet", "active", "ready", "live", "safe"},
		{"inbox", "outbox", "todo", "done", "wait", "hold", "sync", "async", "push", "pull", "send", "recv", "read", "write", "edit", "view", "watch", "build", "ship", "run", "test", "check", "note", "memo", "list", "grid", "feed", "chat", "voice", "call", "desk", "room"},
	}

	paths := make([]string, 0, count)
	targets := depthTargets(count, words[:])
	for depth, target := range targets {
		for i := 0; i < target; i++ {
			paths = append(paths, channelPathForIndex(words[:], depth+1, i))
		}
	}
	return paths
}

func depthTargets(count int, words [][]string) [maxChannelDepth]int {
	weights := [maxChannelDepth]int{2, 12, 34, 32, 20}
	var targets [maxChannelDepth]int
	remaining := count
	for depth := range targets {
		target := count * weights[depth] / 100
		if target == 0 && remaining > 0 {
			target = 1
		}
		capacity := depthCapacity(words, depth+1)
		if target > capacity {
			target = capacity
		}
		targets[depth] = target
		remaining -= target
	}
	for remaining > 0 {
		added := false
		for depth := maxChannelDepth - 1; depth >= 0 && remaining > 0; depth-- {
			if targets[depth] >= depthCapacity(words, depth+1) {
				continue
			}
			targets[depth]++
			remaining--
			added = true
		}
		if !added {
			exit("channel count exceeds channel path capacity")
		}
	}
	return targets
}

func depthCapacity(words [][]string, depth int) int {
	capacity := 1
	for i := 0; i < depth; i++ {
		capacity *= len(words[i])
	}
	return capacity
}

func channelPathForIndex(words [][]string, depth, index int) string {
	parts := make([]string, depth)
	for i := 0; i < depth; i++ {
		levelWords := words[i]
		parts[i] = levelWords[index%len(levelWords)]
		index /= len(levelWords)
	}

	length := depth - 1
	for _, part := range parts {
		length += len(part)
	}
	out := make([]byte, 0, length)
	for i, part := range parts {
		if i > 0 {
			out = append(out, '/')
		}
		out = append(out, part...)
	}
	return string(out)
}
