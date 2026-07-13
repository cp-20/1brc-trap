package main

import (
	"bytes"
	"fmt"
	"testing"
)

func TestMonthIndexFromUnixTimestamp(t *testing.T) {
	for month := 0; month < 12; month++ {
		start := uint32(monthStartUnix[month])
		end := uint32(monthStartUnix[month+1])
		for _, timestamp := range []uint32{start, start + (end-start)/2, end - 1} {
			if got := monthIndexFromUnixTimestamp(timestamp); got != month {
				t.Fatalf("monthIndexFromUnixTimestamp(%d) = %d, want %d", timestamp, got, month)
			}
		}
	}
}

func TestAnalyzeMemoryOutput(t *testing.T) {
	input := "unix_timestamp,channel_path,message_length,stamp_count\n" +
		fmt.Sprintf("%d,team/dev,10,2\n", monthStartUnix[0]) +
		fmt.Sprintf("%d,team/dev,30,4\n", monthStartUnix[0]+1) +
		fmt.Sprintf("%d,team/dev,20,1\n", monthStartUnix[1]) +
		fmt.Sprintf("%d,team/ops,7,0\n", monthStartUnix[11])

	result, err := analyzeMemory([]byte(input), 4, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := writeResult(&output, result); err != nil {
		t.Fatal(err)
	}

	want := "team/dev,2027-01=10/20.00/30/2/6\n" +
		"team/dev,2027-02=20/20.00/20/1/1\n" +
		"team/ops,2027-12=7/7.00/7/1/0\n"
	if output.String() != want {
		t.Fatalf("unexpected output:\n%s\nwant:\n%s", output.String(), want)
	}
}
