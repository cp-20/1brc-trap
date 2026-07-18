#include <algorithm>
#include <fstream>
#include <iomanip>
#include <string>
#include <unordered_map>

struct Stats {
  int min_length = 0;
  int max_length = 0;
  long long total_length = 0;
  long long messages = 0;
  long long stamps = 0;
};

constexpr long long MONTH_START[] = {
    1798761600, 1801440000, 1803859200, 1806537600, 1809129600,
    1811808000, 1814400000, 1817078400, 1819756800, 1822348800,
    1825027200, 1827619200, 1830297600,
};
constexpr const char *MONTH_LABEL[] = {
    "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06",
    "2027-07", "2027-08", "2027-09", "2027-10", "2027-11", "2027-12",
};

int month_index(long long timestamp) {
  for (int month = 0; month < 12; ++month) {
    if (timestamp < MONTH_START[month + 1])
      return month;
  }
  return 11;
}

long long parse_number(const std::string &line, size_t begin, size_t end) {
  long long value = 0;
  for (size_t i = begin; i < end; ++i)
    value = value * 10 + line[i] - '0';
  return value;
}

int main(int argc, char **argv) {
  if (argc != 3)
    return 1;
  std::ifstream input(argv[1]);
  std::ofstream output(argv[2]);
  if (!input || !output)
    return 1;

  std::unordered_map<std::string, Stats> stats;
  std::string line;
  std::getline(input, line);

  while (std::getline(input, line)) {
    size_t comma1 = line.find(',');
    size_t comma2 = line.find(',', comma1 + 1);
    size_t comma3 = line.find(',', comma2 + 1);
    long long timestamp = parse_number(line, 0, comma1);
    std::string channel = line.substr(comma1 + 1, comma2 - comma1 - 1);
    int length = parse_number(line, comma2 + 1, comma3);
    int stamps = parse_number(line, comma3 + 1, line.size());

    int month = month_index(timestamp);
    Stats &s = stats[channel + "," + MONTH_LABEL[month]];
    if (s.messages == 0) {
      s.min_length = s.max_length = length;
    } else {
      s.min_length = std::min(s.min_length, length);
      s.max_length = std::max(s.max_length, length);
    }
    s.total_length += length;
    ++s.messages;
    s.stamps += stamps;
  }

  output << std::fixed << std::setprecision(2);
  for (const auto &[key, s] : stats) {
    output << key << '=' << s.min_length << '/'
           << static_cast<double>(s.total_length) / s.messages << '/'
           << s.max_length << '/' << s.messages << '/' << s.stamps << '\n';
  }
}
