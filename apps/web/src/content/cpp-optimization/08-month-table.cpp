#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <fstream>
#include <iomanip>
#include <stdexcept>
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

struct MappedFile {
  int fd;
  size_t size;
  const char *data;

  explicit MappedFile(const char *path) : fd(open(path, O_RDONLY)) {
    if (fd < 0)
      throw std::runtime_error("cannot open input");
    struct stat info {};
    if (fstat(fd, &info) != 0)
      throw std::runtime_error("cannot stat input");
    size = info.st_size;
    data = static_cast<const char *>(
        mmap(nullptr, size, PROT_READ, MAP_PRIVATE, fd, 0));
    if (data == MAP_FAILED)
      throw std::runtime_error("cannot map input");
  }

  ~MappedFile() {
    munmap(const_cast<char *>(data), size);
    close(fd);
  }
};

constexpr size_t MAP_SIZE = 1 << 14;
constexpr long long YEAR_START = 1798761600;
constexpr int MONTH_START_DAY[] = {
    0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365,
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

constexpr std::array<unsigned char, 365> make_month_table() {
  std::array<unsigned char, 365> table{};
  for (int month = 0; month < 12; ++month) {
    for (int day = MONTH_START_DAY[month]; day < MONTH_START_DAY[month + 1];
         ++day) {
      table[day] = month;
    }
  }
  return table;
}

constexpr auto MONTH_BY_DAY = make_month_table();

int month_index(long long timestamp) {
  return MONTH_BY_DAY[(timestamp - YEAR_START) / 86400];
}

long long parse_number(const char *begin, const char *end) {
  long long value = 0;
  for (const char *p = begin; p < end; ++p)
    value = value * 10 + *p - '0';
  return value;
}

int main(int argc, char **argv) {
  if (argc != 3)
    return 1;
  MappedFile input(argv[1]);
  std::ofstream output(argv[2]);
  if (!output)
    return 1;

  FlatMap stats;
  const char *end = input.data + input.size;
  const char *cursor = std::find(input.data, end, '\n') + 1;

  while (cursor < end) {
    const char *comma1 = std::find(cursor, end, ',');
    const char *comma2 = std::find(comma1 + 1, end, ',');
    const char *comma3 = std::find(comma2 + 1, end, ',');
    const char *line_end = std::find(comma3 + 1, end, '\n');
    long long timestamp = parse_number(cursor, comma1);
    int length = parse_number(comma2 + 1, comma3);
    int stamps = parse_number(comma3 + 1, line_end);

    Entry &entry = stats.find_or_insert(comma1 + 1, comma2 - comma1 - 1);
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
    cursor = line_end + 1;
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
