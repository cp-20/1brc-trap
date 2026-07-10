#include <algorithm>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

struct ChannelStats {
  int min_len;
  int max_len;
  long long total_len;
  long long messages;
  long long stamps;
};

static const long long kMonthStartUnix[] = {
    1798761600LL, 1801440000LL, 1803859200LL, 1806537600LL, 1809129600LL,
    1811808000LL, 1814400000LL, 1817078400LL, 1819756800LL, 1822348800LL,
    1825027200LL, 1827619200LL, 1830297600LL,
};

static const char *kMonthLabels[] = {
    "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06",
    "2027-07", "2027-08", "2027-09", "2027-10", "2027-11", "2027-12",
};

static std::vector<std::string> split_line(const std::string &line) {
  std::vector<std::string> fields;
  std::string field;
  std::stringstream ss(line);
  while (std::getline(ss, field, ',')) {
    fields.push_back(field);
  }
  return fields;
}

static std::string month_label_from_unix_timestamp(long long timestamp) {
  for (int i = 11; i >= 0; --i) {
    if (timestamp >= kMonthStartUnix[i] && timestamp < kMonthStartUnix[i + 1]) {
      return kMonthLabels[i];
    }
  }
  throw std::runtime_error("unix_timestamp out of 2027 range");
}

static std::string result_key(const std::string &unix_timestamp, const std::string &channel_path) {
  return channel_path + "," + month_label_from_unix_timestamp(std::stoll(unix_timestamp));
}

static std::unordered_map<std::string, ChannelStats> analyze(std::istream &input) {
  std::unordered_map<std::string, ChannelStats> stats;
  std::string line;
  long long line_number = 0;

  if (!std::getline(input, line)) {
    throw std::runtime_error("failed to read CSV header");
  }
  line_number++;
  if (split_line(line).size() != 4) {
    throw std::runtime_error("invalid header");
  }

  while (std::getline(input, line)) {
    line_number++;
    if (line.empty()) {
      continue;
    }
    std::vector<std::string> record = split_line(line);
    if (record.size() != 4) {
      throw std::runtime_error("invalid line " + std::to_string(line_number));
    }

    std::string key = result_key(record[0], record[1]);
    int message_length = std::stoi(record[2]);
    int stamp_count = std::stoi(record[3]);

    auto it = stats.find(key);
    if (it == stats.end()) {
      stats[key] = ChannelStats{message_length, message_length, message_length, 1, stamp_count};
      continue;
    }

    ChannelStats &s = it->second;
    if (message_length < s.min_len) {
      s.min_len = message_length;
    }
    if (message_length > s.max_len) {
      s.max_len = message_length;
    }
    s.total_len += message_length;
    s.messages++;
    s.stamps += stamp_count;
  }

  return stats;
}

static void write_result(std::ostream &output, const std::unordered_map<std::string, ChannelStats> &stats) {
  std::vector<std::string> keys;
  keys.reserve(stats.size());
  for (const auto &item : stats) {
    keys.push_back(item.first);
  }
  std::sort(keys.begin(), keys.end());

  output << std::fixed << std::setprecision(2);
  for (const std::string &key : keys) {
    const ChannelStats &s = stats.at(key);
    double mean_len = static_cast<double>(s.total_len) / static_cast<double>(s.messages);
    output << key << "=" << s.min_len << "/" << mean_len << "/" << s.max_len << "/" << s.messages << "/" << s.stamps << "\n";
  }
}

int main(int argc, char **argv) {
  std::string input_path;
  std::string output_path;
  for (int i = 1; i < argc; i++) {
    std::string arg = argv[i];
    if (arg == "-i" && i + 1 < argc) {
      input_path = argv[++i];
    } else if (arg == "-o" && i + 1 < argc) {
      output_path = argv[++i];
    } else {
      std::cerr << "unknown or incomplete argument: " << arg << "\n";
      return 1;
    }
  }

  std::ifstream input_file;
  std::ofstream output_file;
  std::istream *input = &std::cin;
  std::ostream *output = &std::cout;

  if (!input_path.empty()) {
    input_file.open(input_path);
    if (!input_file) {
      std::cerr << "failed to open input\n";
      return 1;
    }
    input = &input_file;
  }
  if (!output_path.empty()) {
    output_file.open(output_path);
    if (!output_file) {
      std::cerr << "failed to open output\n";
      return 1;
    }
    output = &output_file;
  }

  try {
    auto stats = analyze(*input);
    write_result(*output, stats);
  } catch (const std::exception &e) {
    std::cerr << e.what() << "\n";
    return 1;
  }
  return 0;
}
