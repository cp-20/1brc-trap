package main

import (
	"bufio"
	"encoding/hex"
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
	defaultUsers      = 1_000
	defaultBufferSize = 4 * 1024 * 1024
)

type dayWeight struct {
	day    time.Time
	weight float64
}

type channelProfile struct {
	id            string
	ownerUser     int
	ownerShare    float64
	secondaryBias float64
}

func main() {
	rows := flag.Int("n", defaultRows, "number of messages to generate")
	channelCount := flag.Int("channels", defaultChannels, "number of distinct channels")
	userCount := flag.Int("users", defaultUsers, "number of distinct users")
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
	if *userCount <= 0 {
		exit("users must be greater than 0")
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
	g := newGenerator(r, *channelCount, *userCount)
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
	users       []string
	channels    []channelProfile
	channelZipf *rand.Zipf
	userZipf    *rand.Zipf
}

func newGenerator(r *rand.Rand, channelCount, userCount int) *generator {
	users := make([]string, userCount)
	for i := range users {
		users[i] = newUUID(r)
	}

	userZipf := rand.NewZipf(r, 1.18, 1, uint64(userCount-1))
	channels := make([]channelProfile, channelCount)
	for i := range channels {
		mode := r.Float64()
		ownerShare := 0.10 + r.Float64()*0.18
		if mode < 0.12 {
			ownerShare = 0.86 + r.Float64()*0.10
		} else if mode < 0.45 {
			ownerShare = 0.45 + r.Float64()*0.25
		}

		channels[i] = channelProfile{
			id:            newUUID(r),
			ownerUser:     int(userZipf.Uint64()),
			ownerShare:    ownerShare,
			secondaryBias: 1.0 + r.Float64()*1.5,
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
		users:       users,
		channels:    channels,
		channelZipf: rand.NewZipf(r, 1.09, 1, uint64(channelCount-1)),
		userZipf:    userZipf,
	}
}

func (g *generator) write(w io.Writer, rows, bufferSize int) error {
	buffered := bufio.NewWriterSize(w, bufferSize)
	if _, err := buffered.WriteString("iso_timestamp,message_id,user_id,channel_id,message_length,stamp_count\n"); err != nil {
		return err
	}

	line := make([]byte, 0, 192)
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
	userID := g.pickUser(channel)

	line = g.pickTimestamp().AppendFormat(line, "2006-01-02T15:04:05.000Z")
	line = append(line, ',')
	line = append(line, newUUID(g.r)...)
	line = append(line, ',')
	line = append(line, userID...)
	line = append(line, ',')
	line = append(line, channel.id...)
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

func (g *generator) pickUser(channel *channelProfile) string {
	if g.r.Float64() < channel.ownerShare {
		return g.users[channel.ownerUser]
	}

	if g.r.Float64() < channel.secondaryBias/(channel.secondaryBias+4.0) {
		offset := g.r.Intn(30)
		return g.users[(channel.ownerUser+offset)%len(g.users)]
	}

	return g.users[g.userZipf.Uint64()]
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

func newUUID(r *rand.Rand) string {
	var b [16]byte
	for i := 0; i < len(b); i += 8 {
		v := r.Uint64()
		for j := 0; j < 8; j++ {
			b[i+j] = byte(v >> (56 - 8*j))
		}
	}

	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80

	var dst [36]byte
	hex.Encode(dst[0:8], b[0:4])
	dst[8] = '-'
	hex.Encode(dst[9:13], b[4:6])
	dst[13] = '-'
	hex.Encode(dst[14:18], b[6:8])
	dst[18] = '-'
	hex.Encode(dst[19:23], b[8:10])
	dst[23] = '-'
	hex.Encode(dst[24:36], b[10:16])
	return string(dst[:])
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
