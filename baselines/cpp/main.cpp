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

static std::vector<std::string> split_line(const std::string &line) {
  std::vector<std::string> fields;
  std::string field;
  std::stringstream ss(line);
  while (std::getline(ss, field, ',')) {
    fields.push_back(field);
  }
  return fields;
}

static std::unordered_map<std::string, ChannelStats> analyze(std::istream &input) {
  std::unordered_map<std::string, ChannelStats> stats;
  std::string line;
  long long line_number = 0;

  if (!std::getline(input, line)) {
    throw std::runtime_error("failed to read CSV header");
  }
  line_number++;
  if (split_line(line).size() != 6) {
    throw std::runtime_error("invalid header");
  }

  while (std::getline(input, line)) {
    line_number++;
    if (line.empty()) {
      continue;
    }
    std::vector<std::string> record = split_line(line);
    if (record.size() != 6) {
      throw std::runtime_error("invalid line " + std::to_string(line_number));
    }

    const std::string &channel_id = record[3];
    int message_length = std::stoi(record[4]);
    int stamp_count = std::stoi(record[5]);

    auto it = stats.find(channel_id);
    if (it == stats.end()) {
      stats[channel_id] = ChannelStats{message_length, message_length, message_length, 1, stamp_count};
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
  std::vector<std::string> channel_ids;
  channel_ids.reserve(stats.size());
  for (const auto &item : stats) {
    channel_ids.push_back(item.first);
  }
  std::sort(channel_ids.begin(), channel_ids.end());

  output << std::fixed << std::setprecision(2);
  for (const std::string &channel_id : channel_ids) {
    const ChannelStats &s = stats.at(channel_id);
    double mean_len = static_cast<double>(s.total_len) / static_cast<double>(s.messages);
    output << channel_id << "=" << s.min_len << "/" << mean_len << "/" << s.max_len << "/" << s.messages << "/" << s.stamps << "\n";
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
