#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define MAP_CAPACITY (1u << 15)
#define YEAR_START 1798761600u

typedef struct {
  uint64_t messages, total_len, stamps;
  uint32_t min_len, max_len;
} Stats;
typedef struct {
  Stats month[12];
} ChannelAgg;
typedef struct {
  const char *key;
  uint64_t hash;
  uint32_t len, id;
} MapEntry;
typedef struct {
  MapEntry *entries;
  ChannelAgg *aggs;
  uint32_t size, agg_cap;
} FlatMap;
typedef struct {
  const char *begin, *end;
  FlatMap map;
  double elapsed;
} Worker;

static const uint32_t month_start[13] = {
    1798761600u, 1801440000u, 1803859200u, 1806537600u, 1809129600u,
    1811808000u, 1814400000u, 1817078400u, 1819756800u, 1822348800u,
    1825027200u, 1827619200u, 1830297600u};
static const char *month_label[12] = {
    "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06",
    "2027-07", "2027-08", "2027-09", "2027-10", "2027-11", "2027-12"};
static uint8_t month_by_day[365];

static void die(const char *s) {
  perror(s);
  exit(1);
}
static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec + t.tv_nsec * 1e-9;
}
static uint64_t load64(const char *p) {
  uint64_t x;
  memcpy(&x, p, 8);
  return x;
}
static uint64_t rotl(uint64_t x, unsigned n) {
  return (x << n) | (x >> (64 - n));
}
static uint64_t mix64(uint64_t x) {
  x ^= x >> 30;
  x *= 0xbf58476d1ce4e5b9ULL;
  x ^= x >> 27;
  x *= 0x94d049bb133111ebULL;
  return x ^ (x >> 31);
}
static uint64_t hash_bytes(const char *p, size_t n) {
  uint64_t a = 0, b = 0, c = 0;
  if (n >= 24) {
    a = load64(p);
    b = load64(p + n / 2 - 4);
    c = load64(p + n - 8);
  } else if (n >= 8) {
    a = load64(p);
    c = load64(p + n - 8);
  } else
    for (size_t i = 0; i < n; i++)
      a |= (uint64_t)(uint8_t)p[i] << (8 * i);
  return mix64(a * 0x9e3779b185ebca87ULL ^ rotl(b, 21) ^ rotl(c, 43) ^
               (uint64_t)n * 0xd6e8feb86659fd93ULL);
}
static void map_init(FlatMap *m) {
  memset(m, 0, sizeof(*m));
  m->entries = calloc(MAP_CAPACITY, sizeof(MapEntry));
  m->agg_cap = MAP_CAPACITY / 2;
  m->aggs = calloc(m->agg_cap, sizeof(ChannelAgg));
  if (!m->entries || !m->aggs)
    die("calloc");
}
static void map_free(FlatMap *m) {
  free(m->entries);
  free(m->aggs);
}
static MapEntry *map_find(FlatMap *m, const char *key, uint32_t len,
                          uint64_t hash) {
  uint32_t i = (uint32_t)hash & (MAP_CAPACITY - 1);
  for (;;) {
    MapEntry *e = &m->entries[i];
    if (!e->key) {
      if (m->size == m->agg_cap) {
        m->agg_cap *= 2;
        m->aggs = realloc(m->aggs, (size_t)m->agg_cap * sizeof(ChannelAgg));
        if (!m->aggs)
          die("realloc");
        memset(&m->aggs[m->size], 0,
               (m->agg_cap - m->size) * sizeof(ChannelAgg));
      }
      e->key = key;
      e->hash = hash;
      e->len = len;
      e->id = m->size++;
      return e;
    }
    if (e->hash == hash && e->len == len && !memcmp(e->key, key, len))
      return e;
    i = (i + 1) & (MAP_CAPACITY - 1);
  }
}
static void map_add(FlatMap *m, const char *key, uint32_t len, uint64_t hash,
                    uint32_t month, uint32_t message_len, uint32_t stamps) {
  MapEntry *e = map_find(m, key, len, hash);
  Stats *s = &m->aggs[e->id].month[month];
  if (!s->messages) {
    s->messages = 1;
    s->total_len = message_len;
    s->stamps = stamps;
    s->min_len = s->max_len = message_len;
  } else {
    s->messages++;
    s->total_len += message_len;
    s->stamps += stamps;
    if (message_len < s->min_len)
      s->min_len = message_len;
    if (message_len > s->max_len)
      s->max_len = message_len;
  }
}
static void map_merge(FlatMap *dst, const FlatMap *src) {
  for (uint32_t i = 0; i < MAP_CAPACITY; i++) {
    const MapEntry *a = &src->entries[i];
    if (!a->key)
      continue;
    MapEntry *b = map_find(dst, a->key, a->len, a->hash);
    for (unsigned j = 0; j < 12; j++) {
      const Stats *x = &src->aggs[a->id].month[j];
      Stats *y = &dst->aggs[b->id].month[j];
      if (!x->messages)
        continue;
      if (!y->messages)
        *y = *x;
      else {
        y->messages += x->messages;
        y->total_len += x->total_len;
        y->stamps += x->stamps;
        if (x->min_len < y->min_len)
          y->min_len = x->min_len;
        if (x->max_len > y->max_len)
          y->max_len = x->max_len;
      }
    }
  }
}
static uint32_t timestamp10(const char *p) {
  uint32_t x = (uint8_t)(p[0] - '0');
  for (unsigned i = 1; i < 10; i++)
    x = x * 10 + (uint8_t)(p[i] - '0');
  return x;
}
static void *analyze_worker(void *arg) {
  Worker *w = arg;
  double t = now();
  map_init(&w->map);
  const char *p = w->begin;
  while (p < w->end) {
    if (*p == '\n' || *p == '\r') {
      p++;
      continue;
    }
    uint32_t ts = timestamp10(p),
             month = month_by_day[(ts - YEAR_START) / 86400u];
    p += 11;
    const char *key = p;
    while (*p != ',')
      p++;
    uint32_t len = (uint32_t)(p - key);
    uint64_t hash = hash_bytes(key, len);
    p++;
    uint32_t ml = 0;
    while (*p != ',')
      ml = ml * 10 + (uint8_t)(*p++ - '0');
    p++;
    uint32_t stamps = 0;
    while (p < w->end && (uint8_t)(*p - '0') <= 9)
      stamps = stamps * 10 + (uint8_t)(*p++ - '0');
    while (p < w->end && *p != '\n')
      p++;
    if (p < w->end)
      p++;
    map_add(&w->map, key, len, hash, month, ml, stamps);
  }
  w->elapsed = now() - t;
  return NULL;
}
static int compare_entries(const void *aa, const void *bb) {
  const MapEntry *a = *(const MapEntry **)aa, *b = *(const MapEntry **)bb;
  size_t n = a->len < b->len ? a->len : b->len;
  int c = memcmp(a->key, b->key, n);
  return c ? c : (a->len > b->len) - (a->len < b->len);
}
static void write_result(FILE *out, const FlatMap *m) {
  MapEntry **v = malloc((size_t)m->size * sizeof(*v));
  if (!v)
    die("malloc");
  uint32_t n = 0;
  for (uint32_t i = 0; i < MAP_CAPACITY; i++)
    if (m->entries[i].key)
      v[n++] = &m->entries[i];
  qsort(v, n, sizeof(*v), compare_entries);
  char *buf = malloc(4u << 20);
  if (!buf)
    die("malloc");
  size_t used = 0;
  for (uint32_t i = 0; i < n; i++) {
    MapEntry *e = v[i];
    for (unsigned j = 0; j < 12; j++) {
      const Stats *s = &m->aggs[e->id].month[j];
      if (!s->messages)
        continue;
      char tail[128];
      int z =
          snprintf(tail, sizeof(tail),
                   ",%s=%u/%.2f/%u/%" PRIu64 "/%" PRIu64 "\n", month_label[j],
                   s->min_len, (double)s->total_len / (double)s->messages,
                   s->max_len, s->messages, s->stamps);
      if (used + e->len + (size_t)z > (4u << 20)) {
        fwrite(buf, 1, used, out);
        used = 0;
      }
      memcpy(buf + used, e->key, e->len);
      used += e->len;
      memcpy(buf + used, tail, (size_t)z);
      used += (size_t)z;
    }
  }
  fwrite(buf, 1, used, out);
  free(buf);
  free(v);
}
int main(int argc, char **argv) {
  const char *input = NULL, *output = NULL;
  long threads = sysconf(_SC_NPROCESSORS_ONLN);
  int profile = 0;
  for (int i = 1; i < argc; i++) {
    if ((!strcmp(argv[i], "-i") || !strcmp(argv[i], "--input")) && i + 1 < argc)
      input = argv[++i];
    else if ((!strcmp(argv[i], "-o") || !strcmp(argv[i], "--output")) &&
             i + 1 < argc)
      output = argv[++i];
    else if ((!strcmp(argv[i], "-t") || !strcmp(argv[i], "--threads")) &&
             i + 1 < argc)
      threads = strtol(argv[++i], NULL, 10);
    else if (!strcmp(argv[i], "--profile"))
      profile = 1;
    else {
      fprintf(stderr, "unknown argument: %s\n", argv[i]);
      return 1;
    }
  }
  if (!input || threads < 1) {
    fprintf(stderr, "optimized C analyzer requires -i and positive -t\n");
    return 1;
  }
  for (unsigned d = 0, m = 0; d < 365; d++) {
    uint32_t ts = YEAR_START + d * 86400u;
    if (ts >= month_start[m + 1])
      m++;
    month_by_day[d] = (uint8_t)m;
  }
  double total = now(), t = now();
  int fd = open(input, O_RDONLY);
  if (fd < 0)
    die("open");
  struct stat st;
  if (fstat(fd, &st))
    die("fstat");
  size_t size = (size_t)st.st_size;
  const char *data = mmap(NULL, size, PROT_READ, MAP_PRIVATE, fd, 0);
  if (data == MAP_FAILED)
    die("mmap");
  madvise((void *)data, size, MADV_SEQUENTIAL);
  double mmap_time = now() - t;
  const char *nl = memchr(data, '\n', size);
  const char header[] =
      "unix_timestamp,channel_path,message_length,stamp_count";
  if (!nl || (size_t)(nl - data) != sizeof(header) - 1 ||
      memcmp(data, header, sizeof(header) - 1)) {
    fprintf(stderr, "unsupported CSV header\n");
    return 1;
  }
  const char *begin = nl + 1, *end = data + size;
  size_t bytes = (size_t)(end - begin);
  if ((size_t)threads > bytes / 4096 + 1)
    threads = (long)(bytes / 4096 + 1);
  Worker *workers = calloc((size_t)threads, sizeof(*workers));
  pthread_t *ids = malloc((size_t)threads * sizeof(*ids));
  if (!workers || !ids)
    die("alloc");
  t = now();
  const char *start = begin;
  for (long i = 0; i < threads; i++) {
    const char *stop = end;
    if (i + 1 < threads) {
      const char *target = begin + bytes * (size_t)(i + 1) / (size_t)threads;
      const char *x = memchr(target, '\n', (size_t)(end - target));
      if (x)
        stop = x + 1;
    }
    workers[i].begin = start;
    workers[i].end = stop;
    start = stop;
    pthread_create(&ids[i], NULL, analyze_worker, &workers[i]);
  }
  for (long i = 0; i < threads; i++)
    pthread_join(ids[i], NULL);
  double worker_wall = now() - t, worker_sum = 0;
  for (long i = 0; i < threads; i++)
    worker_sum += workers[i].elapsed;
  t = now();
  FlatMap merged;
  map_init(&merged);
  for (long i = 0; i < threads; i++) {
    map_merge(&merged, &workers[i].map);
    map_free(&workers[i].map);
  }
  double merge = now() - t;
  FILE *out = output ? fopen(output, "wb") : stdout;
  if (!out)
    die("fopen");
  t = now();
  write_result(out, &merged);
  fflush(out);
  double output_time = now() - t;
  if (profile) {
    size_t groups = 0;
    for (uint32_t i = 0; i < merged.size; i++)
      for (unsigned j = 0; j < 12; j++)
        groups += merged.aggs[i].month[j].messages != 0;
    fprintf(stderr,
            "profile mmap=%.6f workers_wall=%.6f workers_sum=%.6f merge=%.6f "
            "output=%.6f total=%.6f chunks=%ld groups=%zu\n",
            mmap_time, worker_wall, worker_sum, merge, output_time,
            now() - total, threads, groups);
  }
  if (output)
    fclose(out);
  map_free(&merged);
  free(workers);
  free(ids);
  munmap((void *)data, size);
  close(fd);
  return 0;
}
