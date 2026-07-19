#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <immintrin.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

// Adding BMI2 alone was neutral in an earlier loop (3.93--3.95 s both), but
// the final branchless short/long hash deliberately uses BZHI below.
// Retaining the AVX-512 target (while the hot arithmetic stays 128-bit) lets
// GCC use the larger register file: EC2 1B was 2.36/2.37 s versus 2.37/2.38 s
// for the otherwise identical VEX-only build.
// Retesting after the final hot-loop changes found Sapphire Rapids scheduling
// at 2.26/2.27 s versus 2.27/2.27 s for generic tuning; encode the fixed
// benchmark CPU here so the documented plain `GCC -O3` build receives it.
// Final compiler-matrix rejects: Clang 18 was about 0.10 s slower on EC2 1B;
// GCC unrolling, scheduler/IRA tweaks, forced vector widths, and function
// alignment also lost. Plain LTO left the worker unchanged. An earlier loop
// gained ~15 ms from GCC 15 -Ofast with static LTO+section GC, but the final
// publish+THP ABBA tied -O3 at 1.92579 versus 1.92621 s, so it is not adopted.
#pragma GCC target("avx2,bmi2,sse4.2,avxvnni,avx512bw,avx512vl,tune=sapphirerapids")

#define MAP_CAPACITY (1u << 14)
#define KEY_ARENA_CAPACITY (1u << 20)
#define INPUT_PAGE_SIZE 4096u
#define AGGS_THP_BYTES (2u << 20)
#ifndef FAST_BITS
// EC2 1B A/B: 15 bits covered too few rows (3.257 s), while 18 bits enlarged
// the tables enough to regress (3.043 s); 17 bits was best at 3.017 s total.
// Rejected again in the final memory-bound loop: 16 bits cut table bytes but
// direct coverage fell 99.61% -> 98.71%, regressing 2.10/2.10 -> 2.14/2.14 s.
// Rejected in the older per-worker pipelined layout: three 16-bit-index tables
// saved 128 KiB/worker but merely tied two 17-bit tables at 3.13 s, with
// slightly lower coverage.
// Unlike that per-worker 3x16 experiment, a third shared 17-bit table fits the
// dictionary THP's last 256 KiB. Exact EC2 1B ABBA improved 1.89858 -> 1.89371
// s and direct coverage 99.6094% -> 99.9858%, so retain it as a cold fallback.
#define FAST_BITS 17
#endif
#define FAST_CAPACITY (1u << FAST_BITS)
// ponytail: the contest contract has one closed 10k-channel universe. The
// direct-ID fast path activates only after a worker has discovered all 10k;
// the exact map remains the fallback for table collisions.
#define CONTEST_CHANNELS 10000u
#define YEAR_START 1798761600u

typedef struct {
  // Contest inputs keep every channel-month accumulator below UINT32_MAX.
  // Rejected: splitting 12-byte counters from extrema lost the single SIMD
  // update and slowed EC2 1B workers from 2.999 to 3.527 seconds.
  uint32_t total_len, stamps, messages;
  uint16_t min_len, inv_max_len;
} Stats;
typedef struct {
  uint32_t min_len, max_len;
} WideStats;
typedef struct {
  Stats month[12];
} ChannelAgg;
typedef struct {
  WideStats month[12];
} WideChannelAgg;
typedef struct {
  const char *key;
  uint32_t hash;
  uint16_t len, id;
} MapEntry;
typedef struct {
  MapEntry *entries;
  ChannelAgg *aggs;
  char *keys;
  uint16_t *fast_ids, *fast2_ids, *fast3_ids;
  uint32_t size, agg_cap, key_used;
  void *aggs_alloc;
  size_t aggs_mmap_size;
  void *dictionary_alloc;
  // Allocated only if a contract-valid message length does not fit uint16_t.
  WideChannelAgg *wide;
} FlatMap;
typedef struct {
  const char *begin, *end;
  const FlatMap *dictionary;
  FlatMap map;
  int canonical;
  double elapsed;
} Worker;

// The first worker to see the contract's complete 10k universe publishes its
// exact map. Other workers then discard private dictionaries and update only
// canonical-ID accumulators. EC2 1B improved by 25--34 ms over a serial
// dictionary prepass while preserving the exact-map fallback for small input.
static FlatMap *global_dictionary;

static const uint32_t month_start[13] = {
    1798761600u, 1801440000u, 1803859200u, 1806537600u, 1809129600u,
    1811808000u, 1814400000u, 1817078400u, 1819756800u, 1822348800u,
    1825027200u, 1827619200u, 1830297600u};
static const char month_label[12][8] = {
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
static uint32_t load32(const char *p) {
  uint32_t x;
  memcpy(&x, p, 4);
  return x;
}
static uint16_t load16(const char *p) {
  uint16_t x;
  memcpy(&x, p, 2);
  return x;
}
static inline __attribute__((always_inline)) int
key_equal(const char *a, const char *b, uint32_t n) {
  // Rejected: inlining <=8-byte keys in MapEntry added a hot-path branch and
  // register pressure, outweighing the saved pointer load in local benchmarks.
  if (n >= 8) {
    if (load64(a) != load64(b))
      return 0;
    if (n == 8)
      return 1;
    if (n <= 16)
      return load64(a + n - 8) == load64(b + n - 8);
    if (load64(a + 8) != load64(b + 8))
      return 0;
    if (n <= 24)
      return load64(a + n - 8) == load64(b + n - 8);
    if (n <= 32)
      return load64(a + 16) == load64(b + 16) &&
             load64(a + n - 8) == load64(b + n - 8);
    return !memcmp(a + 16, b + 16, n - 16);
  }
  if (n >= 4) {
    if (load32(a) != load32(b))
      return 0;
    return n == 4 || load32(a + n - 4) == load32(b + n - 4);
  }
  if (n >= 2) {
    if (load16(a) != load16(b))
      return 0;
    return n == 2 || load16(a + n - 2) == load16(b + n - 2);
  }
  return !n || *a == *b;
}
static inline uint64_t rotl64(uint64_t x, unsigned n) {
  return (x << (n & 63)) | (x >> ((64 - n) & 63));
}
static uint32_t hash_bytes(const char *p, size_t n, const char *end) {
  (void)end;
  uint64_t first = load64(p);
  uint64_t short_x = _bzhi_u64(first, (unsigned)n * 8u);
  // For n<8 the discarded tail load starts inside the same complete CSV row.
  uint64_t long_x = first ^ rotl64(load64(p + n - 8), (unsigned)n);
  uint64_t x = short_x;
  // Computing both candidates and selecting with CMOVA removed a roughly
  // 51:49 key-length branch; EC2 1B improved from 2.70/2.71 to 2.42/2.42 s.
  __asm__("cmpq $8, %[length]\n\tcmova %[long_hash], %[hash]"
          : [hash] "+r"(x)
          : [length] "r"(n), [long_hash] "r"(long_x)
          : "cc");
  // Rejected: hashing only first+last increased probing on channel paths.
  // Rejected: marking this 8.4% public-data case unlikely added a rare-path
  // return jump/layout penalty; EC2 1B regressed 2.16/2.16 -> 2.18/2.18 s.
  if (n > 16)
    x ^= rotl64(load64(p + n / 2 - 4), (unsigned)n / 2);
  return (uint32_t)_mm_crc32_u64(n, x);
}
static inline uint32_t fast3_index(uint32_t hash) {
  // Only hashes colliding in both ordinary tables pay for this independent
  // permutation; the 99.6% common path and its instruction schedule stay put.
  // Exact EC2 1B ABBA averaged 1.898578 -> 1.893706 s after dictionary THP.
  return (hash * UINT32_C(0x9e3779b1)) >> (32 - FAST_BITS);
}
static void *mmap_dictionary_thp(void) {
  void *reservation = mmap(NULL, AGGS_THP_BYTES * 2u,
                           PROT_READ | PROT_WRITE,
                           MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (reservation == MAP_FAILED)
    die("mmap dictionary hugepage");
  uintptr_t raw = (uintptr_t)reservation;
  uintptr_t aligned =
      (raw + AGGS_THP_BYTES - 1u) & ~(uintptr_t)(AGGS_THP_BYTES - 1u);
  size_t prefix = (size_t)(aligned - raw);
  size_t suffix = (size_t)(raw + AGGS_THP_BYTES * 2u -
                           (aligned + AGGS_THP_BYTES));
  if ((prefix && munmap((void *)raw, prefix)) ||
      (suffix && munmap((void *)(aligned + AGGS_THP_BYTES), suffix)))
    die("munmap dictionary trim");
  if (madvise((void *)aligned, AGGS_THP_BYTES, MADV_HUGEPAGE))
    die("madvise dictionary hugepage");
  return (void *)aligned;
}
static void map_init(FlatMap *m) {
  memset(m, 0, sizeof(*m));
  size_t entries_bytes = (size_t)MAP_CAPACITY * sizeof(MapEntry);
  size_t fast_bytes = (size_t)FAST_CAPACITY * sizeof(uint16_t);
  size_t dictionary_bytes =
      entries_bytes + KEY_ARENA_CAPACITY + fast_bytes * 3u;
  if (dictionary_bytes > AGGS_THP_BYTES) {
    errno = EOVERFLOW;
    die("dictionary hugepage");
  }
  // entries (256 KiB), key arena (1 MiB), and three ID tables (768 KiB)
  // exactly fill one PMD-sized page. The original dictionary THP first won
  // 12--16 ms in the prepass prototype and 1.93535 -> 1.89713 s after publish.
  char *dictionary = (char *)mmap_dictionary_thp();
  m->dictionary_alloc = dictionary;
  m->entries = (MapEntry *)dictionary;
  m->keys = dictionary + entries_bytes;
  m->fast_ids = (uint16_t *)(m->keys + KEY_ARENA_CAPACITY);
  m->fast2_ids = (uint16_t *)((char *)m->fast_ids + fast_bytes);
  m->fast3_ids = (uint16_t *)((char *)m->fast2_ids + fast_bytes);
  // Every contest worker reaches 10k channels, so it eventually grew to this
  // size anyway. Allocating it once also makes pending Stats pointers stable.
  m->agg_cap = MAP_CAPACITY;
  size_t agg_bytes = (size_t)m->agg_cap * sizeof(ChannelAgg);
  m->aggs_alloc = calloc(1, agg_bytes + 63);
  // Keeping each 192-byte ChannelAgg on a 64-byte boundary was a small but
  // repeatable EC2 1B win (2.78/2.78 -> 2.77/2.77 s).
  m->aggs = (ChannelAgg *)(((uintptr_t)m->aggs_alloc + 63) & ~(uintptr_t)63);
  if (!m->aggs_alloc)
    die("calloc");
}
static void map_init_aggs(FlatMap *m, uint32_t channels) {
  memset(m, 0, sizeof(*m));
  size_t agg_bytes = (size_t)channels * sizeof(ChannelAgg);
  if (agg_bytes > AGGS_THP_BYTES) {
    errno = EOVERFLOW;
    die("worker aggs");
  }
  // A closed 10k-channel accumulator is 1.92 MiB. Aligning each worker to one
  // PMD lets MADV_HUGEPAGE replace hundreds of hot 4 KiB translations.
  void *reservation = mmap(NULL, AGGS_THP_BYTES * 2u,
                           PROT_READ | PROT_WRITE,
                           MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (reservation == MAP_FAILED)
    die("mmap aggs");
  uintptr_t raw = (uintptr_t)reservation;
  uintptr_t aligned =
      (raw + AGGS_THP_BYTES - 1u) & ~(uintptr_t)(AGGS_THP_BYTES - 1u);
  size_t prefix = (size_t)(aligned - raw);
  size_t suffix = (size_t)(raw + AGGS_THP_BYTES * 2u -
                           (aligned + AGGS_THP_BYTES));
  if ((prefix && munmap((void *)raw, prefix)) ||
      (suffix && munmap((void *)(aligned + AGGS_THP_BYTES), suffix)))
    die("munmap aggs trim");
  m->agg_cap = channels;
  m->aggs_alloc = (void *)aligned;
  m->aggs_mmap_size = AGGS_THP_BYTES;
  m->aggs = (ChannelAgg *)m->aggs_alloc;
  if (madvise(m->aggs_alloc, m->aggs_mmap_size, MADV_HUGEPAGE))
    die("madvise aggs hugepage");
  for (uint32_t id = 0; id < channels; id++)
    for (unsigned month = 0; month < 12; month++) {
      m->aggs[id].month[month].min_len = UINT16_MAX;
      m->aggs[id].month[month].inv_max_len = UINT16_MAX;
    }
}
static void map_free(FlatMap *m) {
  if (m->dictionary_alloc) {
    if (munmap(m->dictionary_alloc, AGGS_THP_BYTES))
      die("munmap dictionary");
  } else {
    free(m->entries);
    free(m->keys);
    free(m->fast_ids);
    free(m->fast2_ids);
    free(m->fast3_ids);
  }
  if (m->aggs_mmap_size) {
    if (munmap(m->aggs_alloc, m->aggs_mmap_size))
      die("munmap aggs");
  } else {
    free(m->aggs_alloc);
  }
  free(m->wide);
}
static __attribute__((noinline, cold)) MapEntry *
map_insert(FlatMap *m, MapEntry *e, const char *key, uint32_t len,
           uint32_t hash) {
  if (m->size == m->agg_cap) {
    errno = EOVERFLOW;
    die("channels");
  }
  if (m->key_used + len > KEY_ARENA_CAPACITY) {
    errno = EOVERFLOW;
    die("channel keys");
  }
  e->key = (const char *)memcpy(m->keys + m->key_used, key, len);
  m->key_used += len;
  e->hash = hash;
  e->len = (uint16_t)len;
  e->id = (uint16_t)m->size++;
  uint16_t *fast = &m->fast_ids[hash & (FAST_CAPACITY - 1)];
  *fast = *fast ? UINT16_MAX : (uint16_t)(e->id * 3 + 1);
  fast = &m->fast2_ids[hash >> (32 - FAST_BITS)];
  *fast = *fast ? UINT16_MAX : (uint16_t)(e->id * 3 + 1);
  fast = &m->fast3_ids[fast3_index(hash)];
  *fast = *fast ? UINT16_MAX : (uint16_t)(e->id * 3 + 1);
  // A cold sentinel setup removes the first-sample branch from every row.
  for (unsigned i = 0; i < 12; i++) {
    m->aggs[e->id].month[i].min_len = UINT16_MAX;
    m->aggs[e->id].month[i].inv_max_len = UINT16_MAX;
  }
  return e;
}
// Exact lookup is below 0.8% after discovery. Outlining it removed pending-row
// spills from the hot loop and cut EC2 1B workers from 2.902 to 2.867 seconds.
static __attribute__((noinline)) MapEntry *
map_find(FlatMap *m, const char *key, uint32_t len, uint32_t hash) {
  uint32_t i = hash & (MAP_CAPACITY - 1);
  for (;;) {
    MapEntry *e = &m->entries[i];
    if (!e->key)
      return map_insert(m, e, key, len, hash);
    // Rejected: disabling exact checks after discovering 10k keys added a
    // completion/collision branch per row and was neutral in warm 100M A/B.
    // Rejected: signature-only lookup merged distinct hierarchical paths;
    // hash and length therefore remain filters before an exact byte compare.
    if (e->hash == hash && e->len == len && key_equal(e->key, key, len))
      return e;
    i = (i + 1) & (MAP_CAPACITY - 1);
  }
}
static __attribute__((noinline)) const MapEntry *
map_find_readonly(const FlatMap *m, const char *key, uint32_t len,
                  uint32_t hash) {
  uint32_t i = hash & (MAP_CAPACITY - 1);
  for (;;) {
    const MapEntry *e = &m->entries[i];
    if (!e->key) {
      errno = EINVAL;
      die("published dictionary miss");
    }
    if (e->hash == hash && e->len == len && key_equal(e->key, key, len))
      return e;
    i = (i + 1) & (MAP_CAPACITY - 1);
  }
}
static inline __attribute__((always_inline)) size_t
dictionary_find_slot3_plus1(const FlatMap *m, const char *key, uint32_t len,
                            uint32_t hash) {
  // Held for target A/B: rehashing only the 0.0142% triple collisions in a
  // cold exact helper removes one hash-save uop and 112 hot bytes. A forced
  // 10k-collision harness is exact, but static throughput remains 14 cycles;
  // prior code-shrink attempts have lost on SPR, so it is not adopted blind.
  uint16_t id = m->fast_ids[hash & (FAST_CAPACITY - 1)];
  if (__builtin_expect(id == UINT16_MAX, 0))
    id = m->fast2_ids[hash >> (32 - FAST_BITS)];
  if (__builtin_expect(id == UINT16_MAX, 0))
    id = m->fast3_ids[fast3_index(hash)];
  if (__builtin_expect(id != UINT16_MAX, 1))
    return id;
  return (size_t)map_find_readonly(m, key, len, hash)->id * 3u + 1u;
}
static inline __attribute__((always_inline)) size_t
map_find_slot3_plus1(FlatMap *m, const char *key, uint32_t len,
                     uint32_t hash) {
  // The first two tables directly cover 99.6094% of public rows. Only their
  // double collisions consult table three, raising direct coverage to 99.9858%.
  if (__builtin_expect(m->size == CONTEST_CHANNELS, 1)) {
    uint16_t id = m->fast_ids[hash & (FAST_CAPACITY - 1)];
    // Rejected: staging this load through an AVX-512 K register to overlap
    // numeric dispatch was exact after guarding discovery, but EC2 1B
    // regressed from about 2.10 to 2.20 seconds.
    // Rejected: an assembly CMOV removed this unpredictable collision branch,
    // but loading table two on all rows slowed EC2 1B workers 2.786 -> 2.892 s.
    // Rejected: using the high-hash table first was worse still at 2.902 s.
    // Rejected offline: indexing table one with hash^(hash>>13) lowered exact
    // weighted 1B collisions only 4.434821% -> 4.227585%. It avoids about
    // 4.13M later loads but taxes all 1B rows with SHR+XOR, so it was discarded
    // before an EC2 run rather than perturbing this common dependency chain.
    if (__builtin_expect(id == UINT16_MAX, 0))
      id = m->fast2_ids[hash >> (32 - FAST_BITS)];
    if (__builtin_expect(id == UINT16_MAX, 0))
      id = m->fast3_ids[fast3_index(hash)];
    // At 10k discovery every hash that can occur owns either a direct ID or
    // the collision sentinel; zero remains only in unreachable empty slots.
    // Returning the stored slot3+1 directly folds -64 into the Stats address
    // and removes a subtract plus re-extension per row: 2.24/2.23 ->
    // 2.19/2.20 s on EC2 1B.
    if (__builtin_expect(id != UINT16_MAX, 1))
      return id;
  }
  return (size_t)map_find(m, key, len, hash)->id * 3u + 1u;
}
static inline __attribute__((always_inline)) void
stats_add(Stats *s, __m128i increment) {
  // Rejected: an 8 KiB 256-entry software write-back cache duplicated the
  // hardware cache and added tag/conflict traffic; exact EC2 1B regressed
  // from 2.10/2.09 to 2.90/3.06 seconds.
  // Rejected after the first AVX-512VL win: its masked min/max needed four hot
  // KMOVs; AVX2 min/max+blend improved EC2 1B from 2.38/2.39 to 2.37/2.37 s.
  // Rejected in the old extrema layout: carrying messages=1 in increment only
  // removed one unpack, but four interleaved EC2 1B pairs lost 0.003--0.008 s.
  __m128i values = _mm_loadu_si128((const __m128i *)s);
  __m128i result = _mm_add_epi32(values, increment);
  __m128i length = _mm_broadcastw_epi16(increment);
  // Words 0..5 receive FFFF (identity), word 6 receives length, and word 7
  // receives ~length. Storing max as UINT16_MAX-max lets one VPMINUW update
  // both extrema without masks, KMOVs, or blends; EC2 1B improved from
  // 2.27/2.27 to 2.24/2.24 s.
  __m128i candidate = _mm_ternarylogic_epi32(
      length, _mm_setr_epi16(0, 0, 0, 0, 0, 0, 0, -1),
      _mm_setr_epi16(0, 0, 0, 0, 0, 0, -1, 0), 0x35);
  result = _mm_min_epu16(result, candidate);
  _mm_storeu_si128((__m128i *)s, result);
}
static __attribute__((noinline, cold)) void
stats_add_wide(FlatMap *m, Stats *s, size_t id, uint32_t month,
               uint32_t length, uint32_t stamps) {
  if (!m->wide) {
    m->wide = (WideChannelAgg *)calloc(MAP_CAPACITY, sizeof(*m->wide));
    if (!m->wide)
      die("wide extrema");
  }
  WideStats *x = &m->wide[id].month[month];
  if (!x->max_len) {
    x->min_len = x->max_len = length;
  } else {
    if (length < x->min_len)
      x->min_len = length;
    if (length > x->max_len)
      x->max_len = length;
  }
  s->total_len += length;
  s->stamps += stamps;
  s->messages++;
}
static void map_merge(FlatMap *dst, const FlatMap *src) {
  if (src->wide && !dst->wide) {
    dst->wide = (WideChannelAgg *)calloc(MAP_CAPACITY, sizeof(*dst->wide));
    if (!dst->wide)
      die("wide merge");
  }
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
        // The fallback map merge uses the same lane layout as the canonical-ID
        // path below, so the SIMD counter/extrema merge is exact here too.
        __m128i xv = _mm_loadu_si128((const __m128i *)x);
        __m128i yv = _mm_loadu_si128((const __m128i *)y);
        __m128i sums = _mm_add_epi32(xv, yv);
        __m128i extrema = _mm_min_epu16(xv, yv);
        _mm_storeu_si128((__m128i *)y,
                         _mm_blend_epi16(sums, extrema, 0xc0));
      }
      if (src->wide) {
        const WideStats *wx = &src->wide[a->id].month[j];
        WideStats *wy = &dst->wide[b->id].month[j];
        if (wx->max_len) {
          if (!wy->max_len)
            *wy = *wx;
          else {
            if (wx->min_len < wy->min_len)
              wy->min_len = wx->min_len;
            if (wx->max_len > wy->max_len)
              wy->max_len = wx->max_len;
          }
        }
      }
    }
  }
}
static void map_merge_ids(FlatMap *dst, const FlatMap *src,
                          uint32_t channels) {
  if (src->wide && !dst->wide) {
    dst->wide = (WideChannelAgg *)calloc(MAP_CAPACITY, sizeof(*dst->wide));
    if (!dst->wide)
      die("wide merge");
  }
  for (uint32_t id = 0; id < channels; id++) {
    for (unsigned month = 0; month < 12; month++) {
      const Stats *x = &src->aggs[id].month[month];
      Stats *y = &dst->aggs[id].month[month];
      if (!x->messages)
        continue;
      if (!y->messages)
        *y = *x;
      else {
        // Add the three u32 counters together, then restore the two extrema
        // from unsigned-word minima. EC2 1B ABBA merge averaged
        // 4.609 -> 1.914 ms while retaining the scalar zero/wide fallbacks.
        __m128i xv = _mm_loadu_si128((const __m128i *)x);
        __m128i yv = _mm_loadu_si128((const __m128i *)y);
        __m128i sums = _mm_add_epi32(xv, yv);
        __m128i extrema = _mm_min_epu16(xv, yv);
        _mm_storeu_si128((__m128i *)y,
                         _mm_blend_epi16(sums, extrema, 0xc0));
      }
      if (src->wide) {
        const WideStats *wx = &src->wide[id].month[month];
        WideStats *wy = &dst->wide[id].month[month];
        if (wx->max_len) {
          if (!wy->max_len)
            *wy = *wx;
          else {
            if (wx->min_len < wy->min_len)
              wy->min_len = wx->min_len;
            if (wx->max_len > wy->max_len)
              wy->max_len = wx->max_len;
          }
        }
      }
    }
  }
}
static void canonicalize_worker_map(Worker *w, FlatMap *dictionary) {
  if (dictionary == &w->map) {
    FlatMap hot;
    map_init_aggs(&hot, dictionary->size);
    memcpy(hot.aggs, w->map.aggs,
           (size_t)dictionary->size * sizeof(ChannelAgg));
    void *old_aggs = w->map.aggs_alloc;
    size_t old_mmap_size = w->map.aggs_mmap_size;
    w->map.aggs = hot.aggs;
    w->map.aggs_alloc = hot.aggs_alloc;
    w->map.aggs_mmap_size = hot.aggs_mmap_size;
    w->map.agg_cap = hot.agg_cap;
    if (old_mmap_size) {
      if (munmap(old_aggs, old_mmap_size))
        die("munmap publisher aggs");
    } else {
      free(old_aggs);
    }
    w->dictionary = dictionary;
    w->canonical = 1;
    return;
  }
  FlatMap old = w->map;
  FlatMap canonical;
  map_init_aggs(&canonical, dictionary->size);
  if (old.wide) {
    canonical.wide =
        (WideChannelAgg *)calloc(MAP_CAPACITY, sizeof(*canonical.wide));
    if (!canonical.wide)
      die("wide canonicalize");
  }
  for (uint32_t i = 0; i < MAP_CAPACITY; i++) {
    const MapEntry *local = &old.entries[i];
    if (!local->key)
      continue;
    const MapEntry *shared = map_find_readonly(
        dictionary, local->key, local->len, local->hash);
    canonical.aggs[shared->id] = old.aggs[local->id];
    if (old.wide)
      canonical.wide[shared->id] = old.wide[local->id];
  }
  map_free(&old);
  w->map = canonical;
  w->dictionary = dictionary;
  w->canonical = 1;
}
static inline __attribute__((always_inline)) FlatMap *
maybe_publish_dictionary(Worker *w) {
  FlatMap *dictionary =
      __atomic_load_n(&global_dictionary, __ATOMIC_ACQUIRE);
  if (!dictionary && w->map.size == CONTEST_CHANNELS) {
    FlatMap *expected = NULL;
    if (__atomic_compare_exchange_n(&global_dictionary, &expected, &w->map, 0,
                                    __ATOMIC_RELEASE, __ATOMIC_ACQUIRE))
      dictionary = &w->map;
    else
      dictionary = expected;
  }
  return dictionary;
}
static uint32_t timestamp8(const char *p) {
  // Rejected: decoding five digits through a sparse 2.3 KiB base table and a
  // 316-byte month table slowed EC2 1B from 2.77/2.78 to 2.82/2.82 seconds.
  // A one-table version derived the index in SIMD registers but still tied or
  // slightly lost: 2.31/2.30 versus 2.30/2.30 seconds in ABBA order.
  // Rejected: scalar SWAR won in the superseded C++ loop, but in this shared
  // pipelined kernel it raised EC2 1B workers 2.786 -> 2.979 s.
  __m128i ascii = _mm_loadl_epi64((const __m128i *)p);
  __m128i pairs = _mm_maddubs_epi16(ascii, _mm_set1_epi16(0x010a));
  __m128i quads = _mm_madd_epi16(pairs, _mm_set1_epi32(0x00010064));
  uint64_t x = (uint64_t)_mm_cvtsi128_si64(quads);
  // The dot products include ASCII '0': 53328 * (10000 + 1).
  return (uint32_t)x * 10000u + (uint32_t)(x >> 32) - 533333328u;
}
static uint32_t channel_length(const char *p) {
  const __m128i comma = _mm_set1_epi8(',');
  uint32_t offset = 0;
  // Rejected: AVX-512 mask compares replaced VPMOVMSKB and kept the first
  // result live across timestamp arithmetic, but exact EC2 1B regressed from
  // about 2.10 to 2.23 seconds.
  // Rejected: carrying the first SIMD block into hashing extended its live
  // range and slowed the complete 100M loop despite removing one reload.
  // Rejected: one 32-byte AVX2 first probe grew the pipelined hot loop and
  // slowed EC2 1B workers from 2.786 to 2.820 seconds.
  // Contest rows are complete and every channel is comma-terminated. The
  // anonymous guard page installed by main protects the final SIMD load.
  for (;;) {
    uint32_t mask = (uint32_t)_mm_movemask_epi8(_mm_cmpeq_epi8(
        _mm_loadu_si128((const __m128i *)(p + offset)), comma));
    // Rejected: forcing the common first-block comma to fall through changed
    // GCC 15's global layout and slowed EC2 1B workers 3.004 -> 3.046 s.
    if (mask)
      return offset + (uint32_t)__builtin_ctz(mask);
    offset += 16;
  }
}
// The remaining 0.58% four-digit-length/one-digit-stamp decoder regressed the
// exact EC2 1B gate to 2.162024 s when inlined. Keeping it noinline/cold moves
// the decode and call block into .text.unlikely; with the common-path uop count
// unchanged, exact A/B/B/A improved 1.856762 -> 1.855399 seconds.
static __attribute__((noinline, cold)) __m128i
four_digit_increment(__m128i aligned_tail) {
  __m128i pairs = _mm_maddubs_epi16(
      _mm_srli_epi64(aligned_tail, 8),
      _mm_setr_epi8(10, 1, 10, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0));
  return _mm_dpwssd_epi32(_mm_setr_epi32(-53328, -48, 1, 0), pairs,
                          _mm_setr_epi16(100, 1, 1, 0, 0, 0, 0, 0));
}
static __attribute__((noinline)) void analyze_steady_rows(Worker *w,
                                                          const char *p) {
  const FlatMap *dictionary = w->dictionary;
  Stats ignored = {0, 0, 0, UINT16_MAX, UINT16_MAX};
  Stats *pending_stats = &ignored;
  __m128i pending_increment = _mm_setzero_si128();
  while (p < w->end) {
    uint32_t ts100 = timestamp8(p), delta = ts100 - YEAR_START / 100u;
    uint32_t day = (uint32_t)(((uint64_t)delta * 155345u) >> 27);
    uint32_t month = month_by_day[day];
    p += 11;
    const char *key = p;
    uint32_t len = channel_length(key);
    p += len;
    uint32_t hash = hash_bytes(key, len, w->end);
    size_t slot3_plus1 =
        dictionary_find_slot3_plus1(dictionary, key, len, hash);
    Stats *stats = (Stats *)((char *)w->map.aggs +
                             slot3_plus1 * 64 - 64) +
                   month;
    // An older, larger loop lost about 10 ms with explicit PREFETCHT0, so it
    // was removed there. Retesting after publish+THP+fast3+stamp2 changed the
    // memory schedule: exact EC2 1B ABBA improved 1.861382 -> 1.854790 s.
    // A two-row version was held out before target A/B: GCC added three
    // register moves per row and grew this body 104 bytes (9.9%) for only one
    // extra row of lead. Keep that experiment isolated until it can be timed.
    __builtin_prefetch(stats, 1, 3);
    stats_add(pending_stats, pending_increment);
    p++;
    uint64_t tail = load64(p);
    __m128i increment;
    // Rejected offline: comparing p[3] in memory removed MOV+SHR and 16 hot
    // bytes, but remained 72 uops/14 cycles while adding an overlapping load.
    // The register form stays until a target A/B can justify that load-port tax.
    uint64_t byte3 = tail >> 24;
    uint64_t aligned_tail = (tail << 8) | '0';
    const char *fast_next = p + 5;
    const char *three_next = p + 6;
    __asm__("cmpb $44, %b[byte3]\n\t"
            "cmove %[raw], %[aligned]\n\t"
            "cmove %[three_next], %[next]"
            : [aligned] "+&r"(aligned_tail), [next] "+&r"(fast_next)
            : [byte3] "q"(byte3), [raw] "r"(tail),
              [three_next] "r"(three_next)
            : "cc");
    uint64_t delimiters =
        _pext_u64(aligned_tail, UINT64_C(0x0000ff00ff000000));
    if (__builtin_expect(delimiters == UINT64_C(0x0a2c), 1)) {
      increment = _mm_dpbusd_epi32(
          _mm_setr_epi32(-5328, -48, 1, 0),
          _mm_cvtsi64_si128((int64_t)aligned_tail),
          _mm_setr_epi8(100, 10, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0));
      p = fast_next;
    } else if (__builtin_expect((uint8_t)delimiters == ',' &&
                                    (uint8_t)(aligned_tail >> 48) == '\n',
                                1)) {
      // Two-digit stamps make up 4.6987% of public rows. This slow-only
      // classifier left GCC 15's common path unchanged; exact 1B A/B/B/A
      // improved 1.895142 -> 1.863638 seconds.
      // LF is 10, so its -48 weight supplies the extra -480 ASCII bias and
      // lets this path reuse the one-digit accumulator base.
      increment = _mm_dpbusd_epi32(
          _mm_setr_epi32(-5328, -48, 1, 0),
          _mm_cvtsi64_si128((int64_t)aligned_tail),
          _mm_setr_epi8(100, 10, 1, 0, 10, 1, -48, 0, 0, 0, 0, 0, 0, 0, 0,
                          0));
      p = fast_next + 1;
    } else if (__builtin_expect((uint8_t)(delimiters >> 8) == ',' &&
                                    (uint8_t)(aligned_tail >> 56) == '\n',
                                1)) {
      increment = four_digit_increment(
          _mm_cvtsi64_si128((int64_t)aligned_tail));
      p += 7;
    } else {
      // Rejected inline: VPMADDUBSW+VPDPWSSD for four-digit lengths plus
      // one-digit stamps was exact on general, 10M, and 1B inputs, but its gate
      // regressed the 1.863638-second baseline to 2.162024 seconds.
      uint32_t ml = (uint8_t)(*p++ - '0');
      while (*p != ',')
        ml = ml * 10 + (uint8_t)(*p++ - '0');
      p++;
      uint32_t stamps = (uint8_t)(*p++ - '0');
      while (*p != '\n')
        stamps = stamps * 10 + (uint8_t)(*p++ - '0');
      p++;
      if (__builtin_expect(ml >= UINT16_MAX, 0)) {
        stats_add_wide(&w->map, stats, (slot3_plus1 - 1) / 3, month, ml,
                       stamps);
        pending_stats = &ignored;
        pending_increment = _mm_setzero_si128();
        continue;
      }
      increment = _mm_setr_epi32((int)ml, (int)stamps, 1, 0);
    }
    pending_stats = stats;
    pending_increment = increment;
  }
  stats_add(pending_stats, pending_increment);
}
static void *analyze_worker(void *arg) {
  Worker *w = (Worker *)arg;
  double t = now();
  map_init(&w->map);
  // Rejected: parallel MADV_POPULATE_READ made workers contend while faulting
  // tmpfs up front; EC2 1B regressed from 2.27/2.27 to 2.69/2.54 seconds.
  const char *p = w->begin;
  Stats ignored = {0, 0, 0, UINT16_MAX, UINT16_MAX};
  Stats *pending_stats = &ignored;
  // A real dummy Stats removed the hot null check (2.83/2.82 -> 2.79/2.79 s).
  // Passing the whole pending increment in XMM registers later cut the final
  // per-row scalar construction (2.38/2.38 -> 2.29/2.28 s).
  __m128i pending_increment = _mm_setzero_si128();
  while (p < w->end) {
    // Generated contest chunks begin at a timestamp and every parsed row
    // consumes its newline; a defensive blank-line guard cost two branches/row.
    uint32_t ts100 = timestamp8(p), delta = ts100 - YEAR_START / 100u;
    // Exhaustive over all 315360 possible 100-second offsets in 2027:
    // floor(delta/864) == floor(delta*155345/2^27). This replaces GCC 15's
    // three-instruction reciprocal sequence with one IMUL and one shift;
    // EC2 1B improved from 2.195/2.194 to 2.189/2.184 s.
    uint32_t day = (uint32_t)(((uint64_t)delta * 155345u) >> 27);
    uint32_t month = month_by_day[day];
    p += 11;
    const char *key = p;
    // Rejected: both replacing and early-key-protected 256-slot L0 caches
    // added branches/exact checks and slowed warm 100M workers to 1.34--1.50 s.
    uint32_t len = channel_length(key);
    p += len;
    uint32_t hash = hash_bytes(key, len, w->end);
    size_t slot3_plus1 = map_find_slot3_plus1(&w->map, key, len, hash);
    Stats *stats = (Stats *)((char *)w->map.aggs +
                             slot3_plus1 * 64 - 64) +
                   month;
    // Before direct IDs, doing the exact map lookup here was 2--20% slower.
    // The lookup is now two array reads, so overlap its random Stats miss with
    // the remainder of this row and the key parsing of the next one.
    // Rejected: spelling write-intent PREFETCHW in inline assembly regressed
    // EC2 1B workers from 2.902 to 2.959 s; ordinary T0 was better then.
    // After shrinking the loop, explicit PREFETCHT0 also became redundant:
    // removing it improved 2.20/2.20 to 2.19/2.19 s. The one-row pending
    // pipeline itself still supplies the useful memory-level parallelism.
    // Rejected: moving this update before hash_bytes shortened GCC's worker
    // body but worsened its schedule, regressing EC2 1B 2.10/2.10 -> 2.16/2.16.
    stats_add(pending_stats, pending_increment);
    // Rejected: prefetching the initial slot raised CPU time; the Zipf-hot
    // portion of each worker's table is already cache-resident.
    p++;
    // One unaligned load recognizes the 94.7% common 3/2-digit + 1-digit rows.
    // Rejected: collapsing both cases behind a variable SHRX removed a branch
    // and 69 code bytes but slowed EC2 1B workers from 2.786 to 2.818 seconds.
    uint64_t tail = load64(p);
    __m128i increment;
    uint64_t byte3 = tail >> 24;
    uint64_t aligned_tail = (tail << 8) | '0';
    const char *fast_next = p + 5;
    const char *three_next = p + 6;
    // Reuse one CMP's ZF for both the 2/3-digit alignment and next-row pointer.
    // This removes SETcc/TEST plus the later LEA+ADD pair; EC2 1B improved
    // from 2.16/2.16 to 2.10/2.10 s. Early-clobber prevents input overlap.
    __asm__("cmpb $44, %b[byte3]\n\t"
            "cmove %[raw], %[aligned]\n\t"
            "cmove %[three_next], %[next]"
            : [aligned] "+&r"(aligned_tail), [next] "+&r"(fast_next)
            : [byte3] "q"(byte3), [raw] "r"(tail),
              [three_next] "r"(three_next)
            : "cc");
    // A prior 32-bit shift/mask removed two MOVABS constants and reached
    // 2.27/2.27 s. PEXT now extracts comma+LF in one instruction and improved
    // the late EC2 1B loop from 2.181/2.195 to 2.170/2.172 s.
    uint64_t delimiters =
        _pext_u64(aligned_tail, UINT64_C(0x0000ff00ff000000));
    if (__builtin_expect(delimiters == UINT64_C(0x0a2c), 1)) {
      // VNNI made the original 3-digit path 2.77 -> 2.70 s. Sharing it with
      // 2-digit rows reached 2.39/2.38 s before later optimizations.
      increment = _mm_dpbusd_epi32(
          _mm_setr_epi32(-5328, -48, 1, 0),
          _mm_cvtsi64_si128((int64_t)aligned_tail),
          _mm_setr_epi8(100, 10, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0));
      p = fast_next;
    } else if (__builtin_expect((uint8_t)delimiters == ',' &&
                                    (uint8_t)(aligned_tail >> 48) == '\n',
                                1)) {
      // Two-digit stamps make up 4.6987% of public rows. This slow-only
      // classifier left GCC 15's common path unchanged; exact 1B A/B/B/A
      // improved 1.895142 -> 1.863638 seconds.
      // LF is 10, so its -48 weight supplies the extra -480 ASCII bias and
      // lets this path reuse the one-digit accumulator base.
      increment = _mm_dpbusd_epi32(
          _mm_setr_epi32(-5328, -48, 1, 0),
          _mm_cvtsi64_si128((int64_t)aligned_tail),
          _mm_setr_epi8(100, 10, 1, 0, 10, 1, -48, 0, 0, 0, 0, 0, 0, 0, 0,
                          0));
      p = fast_next + 1;
    } else if (__builtin_expect((uint8_t)(delimiters >> 8) == ',' &&
                                    (uint8_t)(aligned_tail >> 56) == '\n',
                                1)) {
      increment = four_digit_increment(
          _mm_cvtsi64_si128((int64_t)aligned_tail));
      p += 7;
    } else {
      // Rejected inline: VPMADDUBSW+VPDPWSSD for four-digit lengths plus
      // one-digit stamps was exact on general, 10M, and 1B inputs, but its gate
      // regressed the 1.863638-second baseline to 2.162024 seconds.
      uint32_t ml = (uint8_t)(*p++ - '0');
      while (*p != ',')
        ml = ml * 10 + (uint8_t)(*p++ - '0');
      p++;
      uint32_t stamps = (uint8_t)(*p++ - '0');
      while (*p != '\n')
        stamps = stamps * 10 + (uint8_t)(*p++ - '0');
      p++;
      // The public contract bounds group totals, not each message length.
      // Keep 1..65534 in the SIMD representation and send only wider values
      // to an exact 32-bit cold side table; UINT16_MAX remains the sentinel.
      if (__builtin_expect(ml >= UINT16_MAX, 0)) {
        stats_add_wide(&w->map, stats, (slot3_plus1 - 1) / 3, month, ml,
                       stamps);
        pending_stats = &ignored;
        pending_increment = _mm_setzero_si128();
        FlatMap *published = maybe_publish_dictionary(w);
        if (published) {
          canonicalize_worker_map(w, published);
          analyze_steady_rows(w, p);
          goto parsing_done;
        }
        continue;
      }
      increment = _mm_setr_epi32((int)ml, (int)stamps, 1, 0);
    }
    pending_stats = stats;
    pending_increment = increment;
    FlatMap *published = maybe_publish_dictionary(w);
    if (published) {
      stats_add(pending_stats, pending_increment);
      pending_stats = &ignored;
      pending_increment = _mm_setzero_si128();
      canonicalize_worker_map(w, published);
      analyze_steady_rows(w, p);
      goto parsing_done;
    }
  }
  stats_add(pending_stats, pending_increment);
  {
    FlatMap *published =
        __atomic_load_n(&global_dictionary, __ATOMIC_ACQUIRE);
    if (published)
      canonicalize_worker_map(w, published);
  }
parsing_done:
  w->elapsed = now() - t;
  // Keys were copied into the compact arena, so the parsed input pages are no
  // longer referenced. Dropping complete pages here cut EC2 1B wall from
  // 3.02 to 2.85--2.86 s by avoiding one large process-exit teardown.
  uintptr_t drop_begin =
      ((uintptr_t)w->begin + INPUT_PAGE_SIZE - 1) &
      ~(uintptr_t)(INPUT_PAGE_SIZE - 1);
  uintptr_t drop_end =
      (uintptr_t)w->end & ~(uintptr_t)(INPUT_PAGE_SIZE - 1);
  if (drop_end > drop_begin)
    madvise((void *)drop_begin, drop_end - drop_begin, MADV_DONTNEED);
  return NULL;
}
static const char digit_pairs[] =
    "00010203040506070809"
    "10111213141516171819"
    "20212223242526272829"
    "30313233343536373839"
    "40414243444546474849"
    "50515253545556575859"
    "60616263646566676869"
    "70717273747576777879"
    "80818283848586878889"
    "90919293949596979899";
static const uint32_t powers10[] = {
    UINT32_C(1),       UINT32_C(10),       UINT32_C(100),
    UINT32_C(1000),    UINT32_C(10000),    UINT32_C(100000),
    UINT32_C(1000000), UINT32_C(10000000), UINT32_C(100000000),
    UINT32_C(1000000000)};
static inline void store16(char *p, uint16_t x) {
  memcpy(p, &x, sizeof(x));
}
static char *append_uint(char *p, uint32_t x) {
  // Every emitted integer is bounded by the contract's u32 group totals.
  // BSR obtains the width once and /100 emits two digits per iteration;
  // exact EC2 1B ABBA output averaged 8.928 -> 7.620 ms.
  unsigned bits = 32u - (unsigned)__builtin_clz(x | 1);
  unsigned estimate = bits * 1233u >> 12;
  unsigned digits = estimate + (x >= powers10[estimate]);
  digits += digits == 0;
  char *end = p + digits;
  char *q = end;
  while (x >= 100) {
    uint32_t pair = x % 100;
    x /= 100;
    q -= 2;
    store16(q, load16(digit_pairs + pair * 2));
  }
  if (x >= 10) {
    q -= 2;
    store16(q, load16(digit_pairs + x * 2));
  } else {
    *--q = (char)('0' + x);
  }
  return end;
}
static char *append_average(char *p, uint32_t total, uint32_t count) {
  // Rejected: rational integer rounding disagrees with binary64 %.2f at ties.
  double average = (double)total / (double)count;
  uint64_t bits;
  memcpy(&bits, &average, sizeof(bits));
  // A normal binary64 is significand * 2^(exponent-1075). In this uint32
  // domain significand*100 is an exact <60-bit product, so an integer bias
  // gives the same ties-to-even result without 21 generated x87 instructions.
  // Exact reference checks covered 43,179,216 pairs, every exponent, and every
  // reachable tie plus its adjacent binary64 values.
  uint64_t product =
      ((bits & UINT64_C(0x000fffffffffffff)) |
       UINT64_C(0x0010000000000000)) *
      100u;
  unsigned shift = 1075u - ((unsigned)(bits >> 52) & 0x7ffu);
  uint64_t scaled = 0;
  if (shift < 64) {
    uint64_t quotient = product >> shift;
    uint64_t bias =
        (UINT64_C(1) << (shift - 1)) - 1 + (quotient & 1);
    scaled = (product + bias) >> shift;
  }
  p = append_uint(p, scaled / 100);
  *p++ = '.';
  *p++ = (char)('0' + scaled / 10 % 10);
  *p++ = (char)('0' + scaled % 10);
  return p;
}
static void write_result(FILE *out, const FlatMap *m) {
  // The verifier compares a set of records, so table order avoids qsort.
  char *buf = (char *)malloc(4u << 20);
  if (!buf)
    die("malloc");
  size_t used = 0;
  for (uint32_t i = 0; i < MAP_CAPACITY; i++) {
    const MapEntry *e = &m->entries[i];
    if (!e->key)
      continue;
    for (unsigned j = 0; j < 12; j++) {
      const Stats *s = &m->aggs[e->id].month[j];
      if (!s->messages)
        continue;
      if (used + e->len + 96 > (4u << 20)) {
        fwrite(buf, 1, used, out);
        used = 0;
      }
      char *p = buf + used;
      // Every key in the measured public 10k universe is at most 32 bytes. Two
      // XMM copies remove 120k variable-size libc calls from 1B output. Bytes
      // past len stay inside reserved slack: emitted bytes are overwritten
      // below, and any remainder stays beyond used.
      // The dictionary's following ID tables also make both source loads safe
      // at the key arena boundary. Longer general-input keys retain memcpy.
      if (__builtin_expect(e->len <= 32, 1)) {
        __m128i lo = _mm_loadu_si128((const __m128i *)e->key);
        __m128i hi = _mm_loadu_si128((const __m128i *)(e->key + 16));
        _mm_storeu_si128((__m128i *)p, lo);
        _mm_storeu_si128((__m128i *)(p + 16), hi);
      } else {
        __builtin_memcpy(p, e->key, e->len);
      }
      p += e->len;
      *p++ = ',';
      // Copy the label's trailing NUL too, then overwrite it with '=' below.
      // A seven-byte libc memcpy became 120k fortified calls on 1B output;
      // this fixed eight-byte builtin is one unaligned load/store instead.
      uint64_t label = load64(month_label[j]);
      __builtin_memcpy(p, &label, sizeof(label));
      p += 7;
      *p++ = '=';
      const WideStats *wide = m->wide ? &m->wide[e->id].month[j] : NULL;
      uint32_t min_len = s->min_len;
      uint32_t max_len = UINT16_MAX - s->inv_max_len;
      if (wide && wide->max_len) {
        if (min_len == UINT16_MAX)
          min_len = wide->min_len;
        max_len = wide->max_len;
      }
      p = append_uint(p, min_len);
      *p++ = '/';
      p = append_average(p, s->total_len, s->messages);
      *p++ = '/';
      p = append_uint(p, max_len);
      *p++ = '/';
      p = append_uint(p, s->messages);
      *p++ = '/';
      p = append_uint(p, s->stamps);
      *p++ = '\n';
      used = (size_t)(p - buf);
    }
  }
  fwrite(buf, 1, used, out);
  free(buf);
}
int main(int argc, char **argv) {
  const char *input = NULL, *output = NULL;
  // Rejected on the benchmark EC2: 4 and 6 threads took 4.821/4.358 s for 1B,
  // versus 3.718 s with all eight logical CPUs; SMT throughput wins here.
  // Oversubscribing also lost after the final loop: 10/12/16 threads took
  // 3.10/2.95/2.97 s versus 2.85 s with eight at that checkpoint.
  // Rejected: four workers alternating two input cursors were exact but made
  // -t4 regress 2.909 -> 3.477 s. Cursor/end swaps and the larger schedule
  // outweighed the intended MLP and smaller per-worker accumulator footprint.
  long threads = sysconf(_SC_NPROCESSORS_ONLN);
  int profile = 0;
  int first_option = 1;
  if (argc == 3 && argv[1][0] != '-' && argv[2][0] != '-') {
    input = argv[1];
    output = argv[2];
    first_option = argc;
  }
  for (int i = first_option; i < argc; i++) {
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
    fprintf(stderr, "optimized native analyzer requires -i and positive -t\n");
    return 1;
  }
  for (unsigned d = 0, m = 0; d < 365; d++) {
    uint32_t ts = YEAR_START + d * 86400u;
    if (ts >= month_start[m + 1])
      m++;
    // Rejected: storing m*sizeof(Stats) here changed address arithmetic but
    // not its instruction count; EC2 1B lost 2.201/2.202 vs 2.199/2.196 s.
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
  if (size > SIZE_MAX - (INPUT_PAGE_SIZE * 2u - 1u)) {
    errno = EOVERFLOW;
    die("input size");
  }
  size_t mapped_size =
      (size + INPUT_PAGE_SIZE - 1u) & ~(size_t)(INPUT_PAGE_SIZE - 1u);
  // Hot SIMD loads may pass the final newline. Reserve the file's rounded VMA
  // plus one anonymous zero page, then overlay only the file pages. This makes
  // the final-row reads safe even when a private input ends at a page boundary
  // without adding a branch or masked load to the billion-row loop.
  void *reservation = mmap(NULL, mapped_size + INPUT_PAGE_SIZE, PROT_READ,
                           MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (reservation == MAP_FAILED)
    die("mmap guard");
  const char *data = (const char *)mmap(reservation, size, PROT_READ,
                                        MAP_PRIVATE | MAP_FIXED, fd, 0);
  if (data == MAP_FAILED)
    die("mmap");
  // Rejected: removing this hint on resident tmpfs tied/slightly lost EC2 1B
  // (2.238/2.235 versus 2.234/2.236 s), so retain the kernel's scan intent.
  madvise((void *)data, size, MADV_SEQUENTIAL);
  double mmap_time = now() - t;
  const char *nl = (const char *)memchr(data, '\n', size);
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
  Worker *workers = (Worker *)calloc((size_t)threads, sizeof(*workers));
  pthread_t *ids =
      (pthread_t *)malloc((size_t)threads * sizeof(*ids));
  if (!workers || !ids)
    die("alloc");
  t = now();
  const char *start = begin;
  for (long i = 0; i < threads; i++) {
    const char *stop = end;
    if (i + 1 < threads) {
      const char *target = begin + bytes * (size_t)(i + 1) / (size_t)threads;
      const char *x =
          (const char *)memchr(target, '\n', (size_t)(end - target));
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
  FlatMap *published =
      __atomic_load_n(&global_dictionary, __ATOMIC_ACQUIRE);
  FlatMap merged;
  if (published) {
    for (long i = 0; i < threads; i++)
      if (!workers[i].canonical)
        canonicalize_worker_map(&workers[i], published);
    long owner = -1;
    for (long i = 0; i < threads; i++)
      if (&workers[i].map == published)
        owner = i;
    if (owner < 0) {
      errno = EINVAL;
      die("published dictionary owner");
    }
    merged = workers[owner].map;
    for (long i = 0; i < threads; i++) {
      if (i == owner)
        continue;
      map_merge_ids(&merged, &workers[i].map, published->size);
      map_free(&workers[i].map);
    }
  } else {
    merged = workers[0].map;
    for (long i = 1; i < threads; i++) {
      map_merge(&merged, &workers[i].map);
      map_free(&workers[i].map);
    }
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
    uint64_t direct_rows = 0;
    for (uint32_t i = 0; i < merged.size; i++)
      for (unsigned j = 0; j < 12; j++)
        groups += merged.aggs[i].month[j].messages != 0;
    for (uint32_t i = 0; i < MAP_CAPACITY; i++) {
      const MapEntry *e = &merged.entries[i];
      if (!e->key ||
          (merged.fast_ids[e->hash & (FAST_CAPACITY - 1)] == UINT16_MAX &&
           merged.fast2_ids[e->hash >> (32 - FAST_BITS)] == UINT16_MAX &&
           merged.fast3_ids[fast3_index(e->hash)] == UINT16_MAX))
        continue;
      for (unsigned j = 0; j < 12; j++)
        direct_rows += merged.aggs[e->id].month[j].messages;
    }
    fprintf(stderr,
            "profile mmap=%.6f workers_wall=%.6f workers_sum=%.6f merge=%.6f "
            "output=%.6f total=%.6f chunks=%ld shared=%d groups=%zu "
            "direct_rows=%" PRIu64 "\n",
            mmap_time, worker_wall, worker_sum, merge, output_time,
            now() - total, threads, published != NULL, groups, direct_rows);
  }
  if (output)
    fclose(out);
  // ponytail: one-shot CLI; process teardown reclaims mappings and worker maps.
  _exit(0);
}
