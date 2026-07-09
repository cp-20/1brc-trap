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
        if (header.Split(',').Length != 6)
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
            if (record.Length != 6)
            {
                throw new Exception($"invalid line {lineNumber}");
            }

            var channelId = record[3];
            var messageLength = int.Parse(record[4], CultureInfo.InvariantCulture);
            var stampCount = int.Parse(record[5], CultureInfo.InvariantCulture);

            if (!stats.TryGetValue(channelId, out var current))
            {
                stats[channelId] = new ChannelStats
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
        var channelIds = stats.Keys.ToList();
        channelIds.Sort(StringComparer.Ordinal);

        foreach (var channelId in channelIds)
        {
            var s = stats[channelId];
            var meanLen = (double)s.TotalLen / s.Messages;
            output.WriteLine(
                string.Create(
                    CultureInfo.InvariantCulture,
                    $"{channelId}={s.MinLen}/{meanLen:F2}/{s.MaxLen}/{s.Messages}/{s.Stamps}"
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
