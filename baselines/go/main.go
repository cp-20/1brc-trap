package main

import (
	"encoding/csv"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
)

type channelStats struct {
	minLen   int
	maxLen   int
	totalLen int64
	messages int64
	stamps   int64
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

func resultKey(unixTimestamp, channelPath string) (string, error) {
	timestamp, err := strconv.ParseInt(unixTimestamp, 10, 64)
	if err != nil {
		return "", fmt.Errorf("invalid unix_timestamp: %q", unixTimestamp)
	}
	month, err := monthLabelFromUnixTimestamp(timestamp)
	if err != nil {
		return "", err
	}
	return channelPath + "," + month, nil
}

func monthLabelFromUnixTimestamp(timestamp int64) (string, error) {
	for i := len(monthStartUnix) - 2; i >= 0; i-- {
		if timestamp >= monthStartUnix[i] && timestamp < monthStartUnix[i+1] {
			return monthLabels[i], nil
		}
	}
	return "", fmt.Errorf("unix_timestamp out of 2027 range: %d", timestamp)
}

func main() {
	input := flag.String("i", "", "input CSV file path; default is stdin")
	output := flag.String("o", "", "output file path; default is stdout")
	flag.Parse()

	reader, closeReader, err := openInput(*input)
	if err != nil {
		exitWithError(err.Error())
	}
	defer closeReader()

	writer, closeWriter, err := openOutput(*output)
	if err != nil {
		exitWithError(err.Error())
	}
	defer closeWriter()

	stats, err := analyze(reader)
	if err != nil {
		exitWithError(err.Error())
	}
	if err := writeResult(writer, stats); err != nil {
		exitWithError(err.Error())
	}
}

func analyze(r io.Reader) (map[string]*channelStats, error) {
	csvReader := csv.NewReader(r)

	header, err := csvReader.Read()
	if err != nil {
		return nil, fmt.Errorf("failed to read CSV header: %w", err)
	}
	if len(header) != 4 {
		return nil, fmt.Errorf("invalid header: expected 4 columns, got %d", len(header))
	}

	stats := make(map[string]*channelStats)
	lineNumber := 1
	for {
		lineNumber++
		record, err := csvReader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("failed to read line %d: %w", lineNumber, err)
		}
		if len(record) != 4 {
			return nil, fmt.Errorf("invalid line %d: expected 4 columns, got %d", lineNumber, len(record))
		}

		key, err := resultKey(record[0], record[1])
		if err != nil {
			return nil, fmt.Errorf("invalid key on line %d: %w", lineNumber, err)
		}
		messageLength, err := strconv.Atoi(record[2])
		if err != nil {
			return nil, fmt.Errorf("invalid message_length on line %d: %w", lineNumber, err)
		}
		stampCount, err := strconv.Atoi(record[3])
		if err != nil {
			return nil, fmt.Errorf("invalid stamp_count on line %d: %w", lineNumber, err)
		}

		s, ok := stats[key]
		if !ok {
			stats[key] = &channelStats{
				minLen:   messageLength,
				maxLen:   messageLength,
				totalLen: int64(messageLength),
				messages: 1,
				stamps:   int64(stampCount),
			}
			continue
		}

		if messageLength < s.minLen {
			s.minLen = messageLength
		}
		if messageLength > s.maxLen {
			s.maxLen = messageLength
		}
		s.totalLen += int64(messageLength)
		s.messages++
		s.stamps += int64(stampCount)
	}

	return stats, nil
}

func writeResult(w io.Writer, stats map[string]*channelStats) error {
	keys := make([]string, 0, len(stats))
	for key := range stats {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	for _, key := range keys {
		s := stats[key]
		meanLen := float64(s.totalLen) / float64(s.messages)
		if _, err := fmt.Fprintf(
			w,
			"%s=%d/%.2f/%d/%d/%d\n",
			key,
			s.minLen,
			meanLen,
			s.maxLen,
			s.messages,
			s.stamps,
		); err != nil {
			return err
		}
	}

	return nil
}

func openInput(path string) (io.Reader, func(), error) {
	if path == "" {
		return os.Stdin, func() {}, nil
	}

	file, err := os.Open(path)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to open input file: %w", err)
	}
	return file, func() {
		_ = file.Close()
	}, nil
}

func openOutput(path string) (io.Writer, func(), error) {
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

func exitWithError(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
