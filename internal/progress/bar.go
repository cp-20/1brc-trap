package progress

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	barWidth         = 24
	logInterval      = 5 * time.Second
	terminalInterval = 500 * time.Millisecond
)

type Bar struct {
	mu           sync.Mutex
	out          io.Writer
	total        int64
	unit         string
	done         int64
	started      time.Time
	lastReported time.Time
	interactive  bool
	lastWidth    int
	closed       bool
}

func New(out io.Writer, total int64, unit string) *Bar {
	return &Bar{
		out:         out,
		total:       total,
		unit:        unit,
		started:     time.Now(),
		interactive: isTerminal(out),
	}
}

func (bar *Bar) Set(done int64) {
	bar.mu.Lock()
	defer bar.mu.Unlock()
	if done > bar.done {
		bar.done = min(done, bar.total)
	}
	bar.render(false)
}

func (bar *Bar) Add(delta int64) {
	bar.mu.Lock()
	defer bar.mu.Unlock()
	bar.done = min(bar.done+delta, bar.total)
	bar.render(false)
}

func (bar *Bar) Done(complete bool) {
	bar.mu.Lock()
	defer bar.mu.Unlock()
	if bar.closed {
		return
	}
	bar.closed = true
	if complete {
		bar.done = bar.total
	}
	bar.render(true)
}

func (bar *Bar) Reader(reader io.Reader) io.Reader {
	return &progressReader{reader: reader, bar: bar}
}

func (bar *Bar) render(final bool) {
	now := time.Now()
	interval := logInterval
	if bar.interactive {
		interval = terminalInterval
	}
	if !final && now.Sub(bar.lastReported) < interval {
		return
	}
	bar.lastReported = now

	ratio := 1.0
	if bar.total > 0 {
		ratio = float64(bar.done) / float64(bar.total)
	}
	filled := min(int(ratio*barWidth), barWidth)
	elapsed := now.Sub(bar.started)
	rate := float64(bar.done) / elapsed.Seconds()
	eta := time.Duration(0)
	if rate > 0 && bar.done < bar.total {
		eta = time.Duration(float64(bar.total-bar.done) / rate * float64(time.Second)).Round(time.Second)
	}
	line := fmt.Sprintf(
		"[%s%s] %5.1f%% %s / %s %s ETA %s",
		strings.Repeat("=", filled),
		strings.Repeat("-", barWidth-filled),
		ratio*100,
		formatValue(bar.done, bar.unit),
		formatValue(bar.total, bar.unit),
		formatRate(rate, bar.unit),
		eta,
	)
	if bar.interactive {
		padding := max(bar.lastWidth-len(line), 0)
		fmt.Fprintf(bar.out, "\r%s%s", line, strings.Repeat(" ", padding))
		bar.lastWidth = len(line)
		if final {
			fmt.Fprintln(bar.out)
		}
		return
	}
	fmt.Fprintln(bar.out, line)
}

type progressReader struct {
	reader io.Reader
	bar    *Bar
}

func (reader *progressReader) Read(buffer []byte) (int, error) {
	read, err := reader.reader.Read(buffer)
	reader.bar.Add(int64(read))
	return read, err
}

func formatValue(value int64, unit string) string {
	if unit == "bytes" {
		return formatBytes(float64(value))
	}
	return formatCount(value) + " " + unit
}

func formatRate(rate float64, unit string) string {
	if unit == "bytes" {
		return formatBytes(rate) + "/s"
	}
	return fmt.Sprintf("%.2fM %s/s", rate/1_000_000, unit)
}

func formatCount(value int64) string {
	text := strconv.FormatInt(value, 10)
	for index := len(text) - 3; index > 0; index -= 3 {
		text = text[:index] + "," + text[index:]
	}
	return text
}

func formatBytes(value float64) string {
	units := [...]string{"B", "KiB", "MiB", "GiB", "TiB"}
	unit := 0
	for value >= 1024 && unit < len(units)-1 {
		value /= 1024
		unit++
	}
	return fmt.Sprintf("%.1f %s", value, units[unit])
}

func isTerminal(out io.Writer) bool {
	file, ok := out.(*os.File)
	if !ok {
		return false
	}
	info, err := file.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}
