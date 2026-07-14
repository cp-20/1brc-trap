package contestdata

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

func ParseTiers(value string, maximum int64) ([]int64, error) {
	seen := make(map[int64]struct{})
	for _, raw := range strings.Split(value, ",") {
		rows, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
		if err != nil || rows <= 0 || rows > maximum {
			return nil, fmt.Errorf("invalid tier: %s", raw)
		}
		seen[rows] = struct{}{}
	}
	seen[maximum] = struct{}{}
	result := make([]int64, 0, len(seen))
	for rows := range seen {
		result = append(result, rows)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result, nil
}

func tierLabel(rows int64) string {
	switch rows {
	case 1_000_000:
		return "1m"
	case 10_000_000:
		return "10m"
	case 100_000_000:
		return "100m"
	case 1_000_000_000:
		return "1b"
	default:
		return strconv.FormatInt(rows, 10)
	}
}
