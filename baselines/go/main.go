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
	if len(header) != 6 {
		return nil, fmt.Errorf("invalid header: expected 6 columns, got %d", len(header))
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
		if len(record) != 6 {
			return nil, fmt.Errorf("invalid line %d: expected 6 columns, got %d", lineNumber, len(record))
		}

		channelID := record[3]
		messageLength, err := strconv.Atoi(record[4])
		if err != nil {
			return nil, fmt.Errorf("invalid message_length on line %d: %w", lineNumber, err)
		}
		stampCount, err := strconv.Atoi(record[5])
		if err != nil {
			return nil, fmt.Errorf("invalid stamp_count on line %d: %w", lineNumber, err)
		}

		s, ok := stats[channelID]
		if !ok {
			stats[channelID] = &channelStats{
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
	channelIDs := make([]string, 0, len(stats))
	for channelID := range stats {
		channelIDs = append(channelIDs, channelID)
	}
	sort.Strings(channelIDs)

	for _, channelID := range channelIDs {
		s := stats[channelID]
		meanLen := float64(s.totalLen) / float64(s.messages)
		if _, err := fmt.Fprintf(
			w,
			"%s=%d/%.2f/%d/%d/%d\n",
			channelID,
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
