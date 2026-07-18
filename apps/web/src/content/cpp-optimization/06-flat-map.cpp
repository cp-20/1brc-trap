#include <algorithm>
#include <array>
#include <fstream>
#include <iomanip>
#include <string>
#include <vector>

struct Stats {
  int min_length = 0;
  int max_length = 0;
  long long total_length = 0;
  long long messages = 0;
  long long stamps = 0;
};

struct Entry {
  std::string channel;
  std::array<Stats, 12> months{};
};

constexpr size_t MAP_SIZE = 1 << 14;
constexpr long long MONTH_START[] = {
    1798761600, 1801440000, 1803859200, 1806537600, 1809129600,
    1811808000, 1814400000, 1817078400, 1819756800, 1822348800,
    1825027200, 1827619200, 1830297600,
};
constexpr const char *MONTH_LABEL[] = {
    "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06",
    "2027-07", "2027-08", "2027-09", "2027-10", "2027-11", "2027-12",
};

class FlatMap {
public:
  FlatMap() : entries_(MAP_SIZE) {}

  Entry &find_or_insert(const char *channel, size_t length) {
    size_t hash = 1469598103934665603ULL;
    for (size_t i = 0; i < length; ++i) {
      hash = (hash ^ static_cast<unsigned char>(channel[i])) * 1099511628211ULL;
    }

    for (size_t index = hash & (MAP_SIZE - 1);;
         index = (index + 1) & (MAP_SIZE - 1)) {
      Entry &entry = entries_[index];
      if (entry.channel.empty()) {
        entry.channel.assign(channel, length);
        return entry;
      }
      if (entry.channel.size() == length &&
          std::equal(channel, channel + length, entry.channel.begin())) {
        return entry;
      }
    }
  }

  const std::vector<Entry> &entries() const { return entries_; }

private:
  std::vector<Entry> entries_;
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

  FlatMap stats;
  std::string line;
  std::getline(input, line);

  while (std::getline(input, line)) {
    size_t comma1 = line.find(',');
    size_t comma2 = line.find(',', comma1 + 1);
    size_t comma3 = line.find(',', comma2 + 1);
    long long timestamp = parse_number(line, 0, comma1);
    int length = parse_number(line, comma2 + 1, comma3);
    int stamps = parse_number(line, comma3 + 1, line.size());

    Entry &entry =
        stats.find_or_insert(line.data() + comma1 + 1, comma2 - comma1 - 1);
    Stats &s = entry.months[month_index(timestamp)];
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
  for (const Entry &entry : stats.entries()) {
    if (entry.channel.empty())
      continue;
    for (int month = 0; month < 12; ++month) {
      const Stats &s = entry.months[month];
      if (s.messages == 0)
        continue;
      output << entry.channel << ',' << MONTH_LABEL[month] << '='
             << s.min_length << '/'
             << static_cast<double>(s.total_length) / s.messages << '/'
             << s.max_length << '/' << s.messages << '/' << s.stamps << '\n';
    }
  }
}
