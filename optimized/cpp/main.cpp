#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <charconv>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

using Clock = std::chrono::steady_clock;

static constexpr size_t kMaxChannelPathLen = 64;
static constexpr size_t kMonthLen = 7;
static constexpr size_t kKeyLen = kMaxChannelPathLen + 1 + kMonthLen;

static constexpr uint32_t kMonthStartUnix[] = {
    1798761600U, 1801440000U, 1803859200U, 1806537600U, 1809129600U,
    1811808000U, 1814400000U, 1817078400U, 1819756800U, 1822348800U,
    1825027200U, 1827619200U, 1830297600U,
};

static constexpr const char *kMonthLabels[] = {
    "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06",
    "2027-07", "2027-08", "2027-09", "2027-10", "2027-11", "2027-12",
};

struct Profile {
  double mmap_seconds = 0.0;
  double split_seconds = 0.0;
  double worker_wall_seconds = 0.0;
  double worker_sum_seconds = 0.0;
  double merge_seconds = 0.0;
  double output_seconds = 0.0;
  size_t chunks = 0;
  size_t groups = 0;
};

static double elapsed_seconds(Clock::time_point start, Clock::time_point end) {
  return std::chrono::duration<double>(end - start).count();
}

struct Key {
  char bytes[kKeyLen]{};
  uint8_t len = 0;

  friend bool operator==(const Key &a, const Key &b) {
    return a.len == b.len && std::memcmp(a.bytes, b.bytes, a.len) == 0;
  }
  friend bool operator<(const Key &a, const Key &b) {
    int cmp = std::memcmp(a.bytes, b.bytes, std::min(a.len, b.len));
    if (cmp != 0) {
      return cmp < 0;
    }
    return a.len < b.len;
  }
};

struct Stats {
  uint64_t messages = 0;
  uint64_t total_len = 0;
  uint64_t stamps = 0;
  int min_len = 0;
  int max_len = 0;
};

struct Entry {
  Key key;
  Stats stats;
  bool used = false;
};

static inline uint64_t mix64(uint64_t x) {
  x ^= x >> 30;
  x *= 0xbf58476d1ce4e5b9ULL;
  x ^= x >> 27;
  x *= 0x94d049bb133111ebULL;
  x ^= x >> 31;
  return x;
}

static inline uint64_t hash_key(const Key &key) {
  uint64_t h = 1469598103934665603ULL;
  for (uint8_t i = 0; i < key.len; ++i) {
    h ^= static_cast<unsigned char>(key.bytes[i]);
    h *= 1099511628211ULL;
  }
  h ^= key.len;
  return mix64(h);
}

static inline Key parse_key(const char *month, const char *channel, const char *channel_end) {
  Key key;
  size_t channel_len = static_cast<size_t>(channel_end - channel);
  if (channel_len > kMaxChannelPathLen) {
    throw std::runtime_error("channel_path is too long");
  }
  std::memcpy(key.bytes, channel, channel_len);
  key.bytes[channel_len] = ',';
  std::memcpy(key.bytes + channel_len + 1, month, kMonthLen);
  key.len = static_cast<uint8_t>(channel_len + 1 + kMonthLen);
  return key;
}

static inline uint32_t parse_uint_until(const char *&p, char delimiter) {
  uint32_t value = 0;
  while (*p != delimiter) {
    value = value * 10 + static_cast<uint32_t>(*p - '0');
    ++p;
  }
  ++p;
  return value;
}

static inline int month_index_from_unix_timestamp(uint32_t timestamp) {
  for (int i = 11; i >= 0; --i) {
    if (timestamp >= kMonthStartUnix[i]) {
      return i;
    }
  }
  return 0;
}

class FlatMap {
 public:
  explicit FlatMap(size_t initial_capacity = 32768) {
    size_t capacity = 1;
    while (capacity < initial_capacity) {
      capacity <<= 1;
    }
    entries_.resize(capacity);
  }

  void add(Key key, int message_length, int stamp_count) {
    if ((size_ + 1) * 10 >= entries_.size() * 7) {
      rehash(entries_.size() * 2);
    }

    Entry *entry = find_slot(key);
    Stats &stats = entry->stats;
    if (!entry->used) {
      entry->key = key;
      entry->used = true;
      stats.messages = 1;
      stats.total_len = static_cast<uint64_t>(message_length);
      stats.stamps = static_cast<uint64_t>(stamp_count);
      stats.min_len = message_length;
      stats.max_len = message_length;
      ++size_;
      return;
    }

    ++stats.messages;
    stats.total_len += static_cast<uint64_t>(message_length);
    stats.stamps += static_cast<uint64_t>(stamp_count);
    if (message_length < stats.min_len) {
      stats.min_len = message_length;
    }
    if (message_length > stats.max_len) {
      stats.max_len = message_length;
    }
  }

  void merge_from(const FlatMap &other) {
    for (const Entry &entry : other.entries_) {
      if (!entry.used) {
        continue;
      }
      merge(entry.key, entry.stats);
    }
  }

  std::vector<Entry> used_entries() const {
    std::vector<Entry> out;
    out.reserve(size_);
    for (const Entry &entry : entries_) {
      if (entry.used) {
        out.push_back(entry);
      }
    }
    return out;
  }

  size_t size() const {
    return size_;
  }

 private:
  Entry *find_slot(Key key) {
    size_t mask = entries_.size() - 1;
    size_t index = static_cast<size_t>(hash_key(key)) & mask;
    while (entries_[index].used && !(entries_[index].key == key)) {
      index = (index + 1) & mask;
    }
    return &entries_[index];
  }

  void merge(Key key, const Stats &incoming) {
    if ((size_ + 1) * 10 >= entries_.size() * 7) {
      rehash(entries_.size() * 2);
    }

    Entry *entry = find_slot(key);
    if (!entry->used) {
      entry->key = key;
      entry->stats = incoming;
      entry->used = true;
      ++size_;
      return;
    }

    Stats &stats = entry->stats;
    stats.messages += incoming.messages;
    stats.total_len += incoming.total_len;
    stats.stamps += incoming.stamps;
    if (incoming.min_len < stats.min_len) {
      stats.min_len = incoming.min_len;
    }
    if (incoming.max_len > stats.max_len) {
      stats.max_len = incoming.max_len;
    }
  }

  void rehash(size_t new_capacity) {
    std::vector<Entry> old_entries;
    old_entries.swap(entries_);
    entries_.assign(new_capacity, Entry{});
    size_ = 0;

    for (const Entry &entry : old_entries) {
      if (entry.used) {
        merge(entry.key, entry.stats);
      }
    }
  }

  std::vector<Entry> entries_;
  size_t size_ = 0;
};

struct MappedFile {
  int fd = -1;
  const char *data = nullptr;
  size_t size = 0;

  explicit MappedFile(const std::string &path) {
    fd = open(path.c_str(), O_RDONLY);
    if (fd < 0) {
      throw std::runtime_error("failed to open input: " + std::string(std::strerror(errno)));
    }

    struct stat st {};
    if (fstat(fd, &st) != 0) {
      close(fd);
      throw std::runtime_error("failed to stat input: " + std::string(std::strerror(errno)));
    }
    if (st.st_size <= 0) {
      close(fd);
      throw std::runtime_error("input is empty");
    }
    size = static_cast<size_t>(st.st_size);

    void *mapped = mmap(nullptr, size, PROT_READ, MAP_PRIVATE, fd, 0);
    if (mapped == MAP_FAILED) {
      close(fd);
      throw std::runtime_error("failed to mmap input: " + std::string(std::strerror(errno)));
    }
    data = static_cast<const char *>(mapped);
    madvise(const_cast<char *>(data), size, MADV_SEQUENTIAL);
  }

  ~MappedFile() {
    if (data != nullptr) {
      munmap(const_cast<char *>(data), size);
    }
    if (fd >= 0) {
      close(fd);
    }
  }

  MappedFile(const MappedFile &) = delete;
  MappedFile &operator=(const MappedFile &) = delete;
};

struct Chunk {
  const char *begin = nullptr;
  const char *end = nullptr;
};

static const char *find_byte(const char *begin, const char *end, char value) {
  const void *found = std::memchr(begin, value, static_cast<size_t>(end - begin));
  return static_cast<const char *>(found);
}

static std::vector<Chunk> split_chunks(const char *begin, const char *end, unsigned threads) {
  std::vector<Chunk> chunks;
  if (begin >= end) {
    return chunks;
  }

  size_t bytes = static_cast<size_t>(end - begin);
  threads = std::max(1u, std::min<unsigned>(threads, static_cast<unsigned>(bytes / 4096 + 1)));
  chunks.reserve(threads);

  const char *chunk_begin = begin;
  for (unsigned i = 1; i < threads; ++i) {
    const char *target = begin + bytes * i / threads;
    const char *newline = find_byte(target, end, '\n');
    const char *chunk_end = newline == nullptr ? end : newline + 1;
    if (chunk_begin < chunk_end) {
      chunks.push_back(Chunk{chunk_begin, chunk_end});
    }
    chunk_begin = chunk_end;
  }
  if (chunk_begin < end) {
    chunks.push_back(Chunk{chunk_begin, end});
  }
  return chunks;
}

static FlatMap analyze_chunk(Chunk chunk) {
  FlatMap map;
  const char *p = chunk.begin;
  const char *end = chunk.end;

  while (p < end) {
    if (*p == '\n' || *p == '\r') {
      ++p;
      continue;
    }

    uint32_t timestamp = parse_uint_until(p, ',');
    int month = month_index_from_unix_timestamp(timestamp);

    const char *channel = p;
    const char *channel_end = find_byte(channel, end, ',');
    if (channel_end == nullptr) {
      break;
    }
    Key key = parse_key(kMonthLabels[month], channel, channel_end);

    const char *number = channel_end + 1;
    int message_length = static_cast<int>(parse_uint_until(number, ','));
    uint32_t stamp_count = 0;
    while (number < end && *number >= '0' && *number <= '9') {
      stamp_count = stamp_count * 10 + static_cast<uint32_t>(*number - '0');
      ++number;
    }
    while (number < end && *number != '\n') {
      ++number;
    }
    if (number < end) {
      ++number;
    }

    map.add(key, message_length, static_cast<int>(stamp_count));
    p = number;
  }

  return map;
}

static FlatMap analyze_memory(const char *data, size_t size, unsigned threads, Profile *profile) {
  const char *begin = data;
  const char *end = data + size;
  const char *header_end = find_byte(begin, end, '\n');
  if (header_end == nullptr) {
    throw std::runtime_error("failed to read CSV header");
  }
  if (std::string_view(begin, static_cast<size_t>(header_end - begin)) !=
      "unix_timestamp,channel_path,message_length,stamp_count") {
    throw std::runtime_error("unsupported CSV header");
  }

  const char *data_begin = header_end + 1;
  auto split_start = Clock::now();
  std::vector<Chunk> chunks = split_chunks(data_begin, end, threads);
  auto split_end = Clock::now();
  if (profile != nullptr) {
    profile->split_seconds = elapsed_seconds(split_start, split_end);
    profile->chunks = chunks.size();
  }
  if (chunks.empty()) {
    return FlatMap();
  }

  std::vector<FlatMap> locals;
  locals.reserve(chunks.size());
  for (size_t i = 0; i < chunks.size(); ++i) {
    locals.emplace_back();
  }

  std::vector<std::thread> workers;
  workers.reserve(chunks.size());
  std::vector<double> worker_seconds(chunks.size(), 0.0);
  auto workers_start = Clock::now();
  for (size_t i = 0; i < chunks.size(); ++i) {
    workers.emplace_back([&, i]() {
      auto start = Clock::now();
      locals[i] = analyze_chunk(chunks[i]);
      worker_seconds[i] = elapsed_seconds(start, Clock::now());
    });
  }
  for (std::thread &worker : workers) {
    worker.join();
  }
  auto workers_end = Clock::now();
  if (profile != nullptr) {
    profile->worker_wall_seconds = elapsed_seconds(workers_start, workers_end);
    for (double seconds : worker_seconds) {
      profile->worker_sum_seconds += seconds;
    }
  }

  auto merge_start = Clock::now();
  FlatMap merged;
  for (const FlatMap &local : locals) {
    merged.merge_from(local);
  }
  auto merge_end = Clock::now();
  if (profile != nullptr) {
    profile->merge_seconds = elapsed_seconds(merge_start, merge_end);
    profile->groups = merged.size();
  }
  return merged;
}

static void append_key(std::string &out, const Key &key) {
  out.append(key.bytes, key.len);
}

static void write_result(std::ostream &output, const FlatMap &map) {
  std::vector<Entry> entries = map.used_entries();
  std::sort(entries.begin(), entries.end(), [](const Entry &a, const Entry &b) {
    return a.key < b.key;
  });

  std::string line;
  line.reserve(96);
  for (const Entry &entry : entries) {
    const Stats &stats = entry.stats;
    line.clear();
    append_key(line, entry.key);
    line.push_back('=');
    line += std::to_string(stats.min_len);
    line.push_back('/');
    char mean[32];
    int mean_len = std::snprintf(
        mean,
        sizeof(mean),
        "%.2f",
        static_cast<double>(stats.total_len) / static_cast<double>(stats.messages));
    line.append(mean, static_cast<size_t>(mean_len));
    line.push_back('/');
    line += std::to_string(stats.max_len);
    line.push_back('/');
    line += std::to_string(stats.messages);
    line.push_back('/');
    line += std::to_string(stats.stamps);
    line.push_back('\n');
    output.write(line.data(), static_cast<std::streamsize>(line.size()));
  }
}

static unsigned default_threads() {
  unsigned n = std::thread::hardware_concurrency();
  return n == 0 ? 1 : n;
}

int main(int argc, char **argv) {
  std::string input_path;
  std::string output_path;
  unsigned threads = default_threads();
  bool profile_enabled = false;

  for (int i = 1; i < argc; i++) {
    std::string_view arg(argv[i]);
    if ((arg == "-i" || arg == "--input") && i + 1 < argc) {
      input_path = argv[++i];
    } else if ((arg == "-o" || arg == "--output") && i + 1 < argc) {
      output_path = argv[++i];
    } else if ((arg == "-t" || arg == "--threads") && i + 1 < argc) {
      auto value = std::string_view(argv[++i]);
      unsigned parsed = 0;
      auto result = std::from_chars(value.data(), value.data() + value.size(), parsed);
      if (result.ec != std::errc() || parsed == 0) {
        std::cerr << "invalid thread count\n";
        return 1;
      }
      threads = parsed;
    } else if (arg == "--profile") {
      profile_enabled = true;
    } else {
      std::cerr << "unknown or incomplete argument: " << arg << "\n";
      return 1;
    }
  }

  if (input_path.empty()) {
    std::cerr << "fast C++ baseline requires -i/--input for mmap\n";
    return 1;
  }

  try {
    Profile profile;
    auto mmap_start = Clock::now();
    MappedFile input(input_path);
    auto mmap_end = Clock::now();
    if (profile_enabled) {
      profile.mmap_seconds = elapsed_seconds(mmap_start, mmap_end);
    }
    FlatMap stats = analyze_memory(input.data, input.size, threads, profile_enabled ? &profile : nullptr);

    std::ofstream output_file;
    std::ostream *output = &std::cout;
    if (!output_path.empty()) {
      output_file.open(output_path, std::ios::binary);
      if (!output_file) {
        std::cerr << "failed to open output\n";
        return 1;
      }
      output = &output_file;
    }

    auto output_start = Clock::now();
    write_result(*output, stats);
    auto output_end = Clock::now();
    if (profile_enabled) {
      profile.output_seconds = elapsed_seconds(output_start, output_end);
    }
    if (!*output) {
      std::cerr << "failed to write output\n";
      return 1;
    }
    if (profile_enabled) {
      std::cerr
          << "profile mmap=" << profile.mmap_seconds
          << " split=" << profile.split_seconds
          << " workers_wall=" << profile.worker_wall_seconds
          << " workers_sum=" << profile.worker_sum_seconds
          << " merge=" << profile.merge_seconds
          << " output=" << profile.output_seconds
          << " chunks=" << profile.chunks
          << " groups=" << profile.groups
          << "\n";
    }
  } catch (const std::exception &e) {
    std::cerr << e.what() << "\n";
    return 1;
  }

  return 0;
}
