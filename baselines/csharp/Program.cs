using System.Globalization;

record Options(string Input, string Output);

sealed class ChannelStats
{
    public int MinLen;
    public int MaxLen;
    public long TotalLen;
    public long Messages;
    public long Stamps;
}

sealed class Program
{
    static readonly long[] MonthStartUnix =
    [
        1798761600, 1801440000, 1803859200, 1806537600, 1809129600, 1811808000,
        1814400000, 1817078400, 1819756800, 1822348800, 1825027200, 1827619200,
        1830297600,
    ];

    static readonly string[] MonthLabels =
    [
        "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06",
        "2027-07", "2027-08", "2027-09", "2027-10", "2027-11", "2027-12",
    ];

    static string ResultKey(string unixTimestamp, string channelPath)
    {
        var timestamp = long.Parse(unixTimestamp, CultureInfo.InvariantCulture);
        return $"{channelPath},{MonthLabelFromUnixTimestamp(timestamp)}";
    }

    static string MonthLabelFromUnixTimestamp(long timestamp)
    {
        for (var i = MonthStartUnix.Length - 2; i >= 0; i--)
        {
            if (timestamp >= MonthStartUnix[i] && timestamp < MonthStartUnix[i + 1])
            {
                return MonthLabels[i];
            }
        }
        throw new Exception($"unix_timestamp out of 2027 range: {timestamp}");
    }

    static Options ParseArgs(string[] args)
    {
        var input = "";
        var output = "";
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] == "-i" && i + 1 < args.Length)
            {
                input = args[++i];
            }
            else if (args[i] == "-o" && i + 1 < args.Length)
            {
                output = args[++i];
            }
            else
            {
                throw new Exception($"unknown or incomplete argument: {args[i]}");
            }
        }
        return new Options(input, output);
    }

    static Dictionary<string, ChannelStats> Analyze(TextReader input)
    {
        var stats = new Dictionary<string, ChannelStats>();
        var lineNumber = 0;

        var header = input.ReadLine();
        lineNumber++;
        if (header is null)
        {
            throw new Exception("failed to read CSV header");
        }
        if (header.Split(',').Length != 4)
        {
            throw new Exception("invalid header");
        }

        string? line;
        while ((line = input.ReadLine()) is not null)
        {
            lineNumber++;
            if (line.Length == 0)
            {
                continue;
            }

            var record = line.Split(',');
            if (record.Length != 4)
            {
                throw new Exception($"invalid line {lineNumber}");
            }

            var key = ResultKey(record[0], record[1]);
            var messageLength = int.Parse(record[2], CultureInfo.InvariantCulture);
            var stampCount = int.Parse(record[3], CultureInfo.InvariantCulture);

            if (!stats.TryGetValue(key, out var current))
            {
                stats[key] = new ChannelStats
                {
                    MinLen = messageLength,
                    MaxLen = messageLength,
                    TotalLen = messageLength,
                    Messages = 1,
                    Stamps = stampCount,
                };
                continue;
            }

            if (messageLength < current.MinLen)
            {
                current.MinLen = messageLength;
            }
            if (messageLength > current.MaxLen)
            {
                current.MaxLen = messageLength;
            }
            current.TotalLen += messageLength;
            current.Messages++;
            current.Stamps += stampCount;
        }

        return stats;
    }

    static void WriteResult(TextWriter output, Dictionary<string, ChannelStats> stats)
    {
        var keys = stats.Keys.ToList();
        keys.Sort(StringComparer.Ordinal);

        foreach (var key in keys)
        {
            var s = stats[key];
            var meanLen = (double)s.TotalLen / s.Messages;
            output.WriteLine(
                string.Create(
                    CultureInfo.InvariantCulture,
                    $"{key}={s.MinLen}/{meanLen:F2}/{s.MaxLen}/{s.Messages}/{s.Stamps}"
                )
            );
        }
    }

    static int Main(string[] args)
    {
        try
        {
            var options = ParseArgs(args);
            using var inputFile = options.Input == "" ? null : File.OpenText(options.Input);
            using var outputFile = options.Output == "" ? null : new StreamWriter(options.Output);
            var input = inputFile ?? Console.In;
            var output = outputFile ?? Console.Out;

            var stats = Analyze(input);
            WriteResult(output, stats);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
    }
}
