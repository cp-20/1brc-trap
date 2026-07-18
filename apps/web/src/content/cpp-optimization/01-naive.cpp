#include <algorithm>
#include <ctime>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <string>
#include <unordered_map>

struct Stats {
  int min_length = 0;
  int max_length = 0;
  long long total_length = 0;
  long long messages = 0;
  long long stamps = 0;
};

int main(int argc, char **argv) {
  if (argc != 3)
    return 1;

  std::ifstream input(argv[1]);
  std::ofstream output(argv[2]);
  if (!input || !output)
    return 1;

  std::unordered_map<std::string, Stats> stats;
  std::string line;
  std::getline(input, line); // ヘッダーを読み飛ばす

  while (std::getline(input, line)) {
    std::stringstream row(line);
    std::string timestamp, channel, length_text, stamps_text;
    std::getline(row, timestamp, ',');
    std::getline(row, channel, ',');
    std::getline(row, length_text, ',');
    std::getline(row, stamps_text, ',');

    std::time_t seconds = std::stoll(timestamp);
    std::tm utc{};
    gmtime_r(&seconds, &utc);
    char month[8];
    std::strftime(month, sizeof(month), "%Y-%m", &utc);

    int length = std::stoi(length_text);
    int stamps = std::stoi(stamps_text);
    Stats &s = stats[channel + "," + month];
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
