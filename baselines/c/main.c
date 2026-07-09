#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  char *key;
  int min_len;
  int max_len;
  long long total_len;
  long long messages;
  long long stamps;
  int used;
} Entry;

typedef struct {
  Entry *entries;
  size_t capacity;
  size_t count;
} Map;

static unsigned long hash_string(const char *s) {
  unsigned long h = 1469598103934665603UL;
  while (*s) {
    h ^= (unsigned char)*s++;
    h *= 1099511628211UL;
  }
  return h;
}

static char *copy_string(const char *s) {
  size_t len = strlen(s);
  char *copy = (char *)malloc(len + 1);
  if (copy == NULL) {
    fprintf(stderr, "out of memory\n");
    exit(1);
  }
  memcpy(copy, s, len + 1);
  return copy;
}

static void map_init(Map *map) {
  map->capacity = 32768;
  map->count = 0;
  map->entries = (Entry *)calloc(map->capacity, sizeof(Entry));
  if (map->entries == NULL) {
    fprintf(stderr, "out of memory\n");
    exit(1);
  }
}

static void map_free(Map *map) {
  for (size_t i = 0; i < map->capacity; i++) {
    free(map->entries[i].key);
  }
  free(map->entries);
}

static void map_rehash(Map *map) {
  Entry *old_entries = map->entries;
  size_t old_capacity = map->capacity;
  map->capacity *= 2;
  map->entries = (Entry *)calloc(map->capacity, sizeof(Entry));
  if (map->entries == NULL) {
    fprintf(stderr, "out of memory\n");
    exit(1);
  }
  map->count = 0;

  for (size_t i = 0; i < old_capacity; i++) {
    if (!old_entries[i].used) {
      continue;
    }
    unsigned long h = hash_string(old_entries[i].key);
    size_t pos = h % map->capacity;
    while (map->entries[pos].used) {
      pos = (pos + 1) % map->capacity;
    }
    map->entries[pos] = old_entries[i];
    map->count++;
  }
  free(old_entries);
}

static Entry *map_get_or_insert(Map *map, const char *key, int message_length, int stamp_count, int *inserted) {
 if ((map->count + 1) * 10 > map->capacity * 7) {
    map_rehash(map);
  }

  unsigned long h = hash_string(key);
  size_t pos = h % map->capacity;
  while (map->entries[pos].used) {
    if (strcmp(map->entries[pos].key, key) == 0) {
      *inserted = 0;
      return &map->entries[pos];
    }
    pos = (pos + 1) % map->capacity;
  }

  Entry *entry = &map->entries[pos];
  entry->key = copy_string(key);
  entry->min_len = message_length;
  entry->max_len = message_length;
  entry->total_len = message_length;
  entry->messages = 1;
  entry->stamps = stamp_count;
  entry->used = 1;
  map->count++;
  *inserted = 1;
  return entry;
}

static int compare_entries(const void *a, const void *b) {
  const Entry *ea = *(const Entry **)a;
  const Entry *eb = *(const Entry **)b;
  return strcmp(ea->key, eb->key);
}

static int split_line(char *line, char **fields, int max_fields) {
  int count = 0;
  char *start = line;
  for (char *p = line; ; p++) {
    if (*p == ',' || *p == '\0' || *p == '\n' || *p == '\r') {
      char saved = *p;
      *p = '\0';
      if (count < max_fields) {
        fields[count] = start;
      }
      count++;
      if (saved == '\0' || saved == '\n' || saved == '\r') {
        break;
      }
      start = p + 1;
    }
  }
  return count;
}

static void analyze(FILE *input, Map *map) {
  char line[4096];
  char *fields[6];
  long long line_number = 0;

  if (fgets(line, sizeof(line), input) == NULL) {
    fprintf(stderr, "failed to read CSV header\n");
    exit(1);
  }
  line_number++;
  if (split_line(line, fields, 6) != 6) {
    fprintf(stderr, "invalid header\n");
    exit(1);
  }

  while (fgets(line, sizeof(line), input) != NULL) {
    line_number++;
    if (line[0] == '\n' || line[0] == '\r' || line[0] == '\0') {
      continue;
    }
    if (split_line(line, fields, 6) != 6) {
      fprintf(stderr, "invalid line %lld\n", line_number);
      exit(1);
    }

    int message_length = atoi(fields[4]);
    int stamp_count = atoi(fields[5]);
    int inserted = 0;
    Entry *entry = map_get_or_insert(map, fields[3], message_length, stamp_count, &inserted);
    if (inserted) {
      continue;
    }
    if (message_length < entry->min_len) {
      entry->min_len = message_length;
    }
    if (message_length > entry->max_len) {
      entry->max_len = message_length;
    }
    entry->total_len += message_length;
    entry->messages++;
    entry->stamps += stamp_count;
  }
}

static void write_result(FILE *output, Map *map) {
  Entry **entries = (Entry **)malloc(map->count * sizeof(Entry *));
  if (entries == NULL) {
    fprintf(stderr, "out of memory\n");
    exit(1);
  }

  size_t n = 0;
  for (size_t i = 0; i < map->capacity; i++) {
    if (map->entries[i].used) {
      entries[n++] = &map->entries[i];
    }
  }
  qsort(entries, n, sizeof(Entry *), compare_entries);

  for (size_t i = 0; i < n; i++) {
    Entry *e = entries[i];
    double mean = (double)e->total_len / (double)e->messages;
    fprintf(output, "%s=%d/%.2f/%d/%lld/%lld\n", e->key, e->min_len, mean, e->max_len, e->messages, e->stamps);
  }

  free(entries);
}

int main(int argc, char **argv) {
  const char *input_path = NULL;
  const char *output_path = NULL;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "-i") == 0 && i + 1 < argc) {
      input_path = argv[++i];
    } else if (strcmp(argv[i], "-o") == 0 && i + 1 < argc) {
      output_path = argv[++i];
    } else {
      fprintf(stderr, "unknown or incomplete argument: %s\n", argv[i]);
      return 1;
    }
  }

  FILE *input = input_path == NULL ? stdin : fopen(input_path, "r");
  if (input == NULL) {
    fprintf(stderr, "failed to open input: %s\n", strerror(errno));
    return 1;
  }
  FILE *output = output_path == NULL ? stdout : fopen(output_path, "w");
  if (output == NULL) {
    fprintf(stderr, "failed to open output: %s\n", strerror(errno));
    return 1;
  }

  Map map;
  map_init(&map);
  analyze(input, &map);
  write_result(output, &map);
  map_free(&map);

  if (input != stdin) {
    fclose(input);
  }
  if (output != stdout) {
    fclose(output);
  }
  return 0;
}
