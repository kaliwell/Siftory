#pragma once

#include <condition_variable>
#include <deque>
#include <memory>

namespace thumbnail_sidecar {

static constexpr size_t kMinQueueCapacity = 64;
static constexpr size_t kMaxQueueCapacity = 256;
static constexpr size_t kMaxDeferredEntries = 65536;
static constexpr size_t kMaxDeferredPathBytes = 32ULL * 1024 * 1024;
static constexpr int kMinScanWorkerCount = 1;
static constexpr int kMaxScanWorkerCount = 2;
static constexpr int kMinFillWorkerCount = 2;
static constexpr int kMaxFillWorkerCount = 8;
static constexpr size_t kRetainedInputLimitBytes = 128ULL * 1024 * 1024;

struct WorkerPolicy {
  int scanWorkerCount = kMinScanWorkerCount;
  int fillWorkerCount = kMinFillWorkerCount;
  size_t queueCapacity = kMinQueueCapacity;
  uint32_t logicalProcessors = 0;
  uint64_t totalMemoryBytes = 0;
  uint64_t availableMemoryBytes = 0;
  bool overridden = false;
};

static bool read_worker_override(const char* name, int minimum, int maximum, int& value) {
  char buffer[16] = {};
  const DWORD length = GetEnvironmentVariableA(name, buffer, static_cast<DWORD>(sizeof(buffer)));
  if (length == 0 || length >= sizeof(buffer)) return false;
  char* end = nullptr;
  const long parsed = std::strtol(buffer, &end, 10);
  if (!end || *end != '\0' || parsed < minimum || parsed > maximum) return false;
  value = static_cast<int>(parsed);
  return true;
}

static int memory_fill_worker_cap(uint64_t totalBytes, uint64_t availableBytes) {
  constexpr uint64_t GiB = 1024ULL * 1024 * 1024;
  int totalCap = kMaxFillWorkerCount;
  if (totalBytes > 0 && totalBytes < 6 * GiB) totalCap = 2;
  else if (totalBytes > 0 && totalBytes < 10 * GiB) totalCap = 4;
  else if (totalBytes > 0 && totalBytes < 14 * GiB) totalCap = 6;
  int availableCap = kMaxFillWorkerCount;
  if (availableBytes > 0 && availableBytes < 2 * GiB) availableCap = 2;
  else if (availableBytes > 0 && availableBytes < 4 * GiB) availableCap = 4;
  else if (availableBytes > 0 && availableBytes < 6 * GiB) availableCap = 6;
  return std::min(totalCap, availableCap);
}

static WorkerPolicy select_worker_policy() {
  WorkerPolicy result;
  result.logicalProcessors = std::max(1u, std::thread::hardware_concurrency());
  MEMORYSTATUSEX memory = {};
  memory.dwLength = sizeof(memory);
  if (GlobalMemoryStatusEx(&memory)) {
    result.totalMemoryBytes = memory.ullTotalPhys;
    result.availableMemoryBytes = memory.ullAvailPhys;
  }
  const int cpuFillTarget =
      std::clamp(static_cast<int>((result.logicalProcessors + 1) / 2),
                 kMinFillWorkerCount, kMaxFillWorkerCount);
  result.fillWorkerCount = std::clamp(
      std::min(cpuFillTarget,
               memory_fill_worker_cap(result.totalMemoryBytes, result.availableMemoryBytes)),
      kMinFillWorkerCount, kMaxFillWorkerCount);
  result.scanWorkerCount = std::clamp(
      static_cast<int>((result.logicalProcessors + 7) / 8), kMinScanWorkerCount,
      kMaxScanWorkerCount);
  int overrideValue = 0;
  if (read_worker_override("REASONIX_NATIVE_THUMB_SCAN_WORKERS", 1,
                           kMaxFillWorkerCount, overrideValue)) {
    result.scanWorkerCount = overrideValue;
    result.overridden = true;
  }
  if (read_worker_override("REASONIX_NATIVE_THUMB_FILL_WORKERS", 1,
                           kMaxFillWorkerCount, overrideValue)) {
    result.fillWorkerCount = overrideValue;
    result.overridden = true;
  }
  result.fillWorkerCount = std::max(result.scanWorkerCount, result.fillWorkerCount);
  result.queueCapacity = std::clamp(static_cast<size_t>(result.scanWorkerCount) * 64,
                                    kMinQueueCapacity, kMaxQueueCapacity);
  if (read_worker_override("REASONIX_NATIVE_THUMB_QUEUE_CAPACITY", 1, 512,
                           overrideValue)) {
    result.queueCapacity = static_cast<size_t>(overrideValue);
    result.overridden = true;
  }
  return result;
}

struct Job {
  std::string sourcePath;
  int64_t modifiedTime = 0;
  std::shared_ptr<std::vector<uint8_t>> encodedBytes;
  bool fillJob = false;
};

struct Stats {
  bool enabled = false;
  int64_t queued = 0;
  int64_t completed = 0;
  int64_t failed = 0;
  int64_t dropped = 0;
  int64_t pending = 0;
  int64_t inputReused = 0;
  int64_t inputReusedBytes = 0;
  int64_t inputFallback = 0;
  int64_t sourceReads = 0;
  int64_t retainedInputBytes = 0;
  int64_t retainedInputLimitBytes = static_cast<int64_t>(kRetainedInputLimitBytes);
  int64_t workerCount = 0;
  int64_t scanWorkerCount = 0;
  int64_t fillWorkerCount = 0;
  int64_t queueCapacity = 0;
  int64_t deferred = 0;
  int64_t deferredPending = 0;
  int64_t deferredPathBytes = 0;
  int64_t deferredEntryLimit = static_cast<int64_t>(kMaxDeferredEntries);
  int64_t deferredPathLimitBytes = static_cast<int64_t>(kMaxDeferredPathBytes);
  int64_t fillCompleted = 0;
  int64_t fillFailed = 0;
  int64_t cancelled = 0;
  int64_t logicalProcessors = 0;
  int64_t totalMemoryBytes = 0;
  int64_t availableMemoryBytes = 0;
  bool workerOverride = false;
  std::string phase = "idle";
};

static std::mutex g_mutex;
static std::condition_variable g_ready;
static std::deque<Job> g_jobs;
static std::deque<Job> g_deferredJobs;
static std::vector<std::thread> g_workers;
static std::string g_cacheDir;
static std::wstring g_normalizedCacheDir;
static int g_cacheVersion = 5;
static bool g_enabled = false;
static bool g_accepting = false;
static bool g_stopping = false;
static bool g_fillPhase = false;
static WorkerPolicy g_workerPolicy;
static std::atomic<int64_t> g_queued{0};
static std::atomic<int64_t> g_completed{0};
static std::atomic<int64_t> g_failed{0};
static std::atomic<int64_t> g_dropped{0};
static std::atomic<int64_t> g_active{0};
static std::atomic<int64_t> g_inputReused{0};
static std::atomic<int64_t> g_inputReusedBytes{0};
static std::atomic<int64_t> g_inputFallback{0};
static std::atomic<int64_t> g_sourceReads{0};
static std::atomic<int64_t> g_deferred{0};
static std::atomic<int64_t> g_fillCompleted{0};
static std::atomic<int64_t> g_fillFailed{0};
static std::atomic<int64_t> g_cancelled{0};
static size_t g_retainedInputBytes = 0;
static size_t g_deferredPathBytes = 0;

static bool is_excluded_source(const std::string& sourcePath) {
  return !g_normalizedCacheDir.empty() &&
         thumbnail_rebuilder::same_or_descendant(path_from_utf8(sourcePath),
                                                  g_normalizedCacheDir);
}

static bool wants_encoded_input(const std::string& sourcePath) {
  if (sourcePath.empty() || is_excluded_source(sourcePath) ||
      !thumbnail_rebuilder::is_jpeg_path(path_from_utf8(sourcePath))) {
    return false;
  }
  std::lock_guard<std::mutex> lock(g_mutex);
  return g_enabled && g_accepting && !g_stopping;
}

static void release_retained_input(const Job& job) {
  if (!job.encodedBytes) return;
  const size_t bytes = job.encodedBytes->size();
  std::lock_guard<std::mutex> lock(g_mutex);
  g_retainedInputBytes = bytes >= g_retainedInputBytes ? 0 : g_retainedInputBytes - bytes;
}

static void worker_loop() {
  const HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  IWICImagingFactory* factory = nullptr;
  if (SUCCEEDED(com))
    CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                     IID_PPV_ARGS(&factory));
  while (true) {
    Job job;
    {
      std::unique_lock<std::mutex> lock(g_mutex);
      g_ready.wait(lock, [] {
        return g_stopping || !g_jobs.empty() ||
               (g_fillPhase && !g_deferredJobs.empty()) || !g_accepting;
      });
      if (g_stopping) break;
      if (!g_jobs.empty()) {
        job = std::move(g_jobs.front());
        g_jobs.pop_front();
      } else if (g_fillPhase && !g_deferredJobs.empty()) {
        job = std::move(g_deferredJobs.front());
        g_deferredJobs.pop_front();
        const size_t pathBytes = job.sourcePath.size();
        g_deferredPathBytes = pathBytes >= g_deferredPathBytes
                                  ? 0
                                  : g_deferredPathBytes - pathBytes;
      } else if (!g_accepting) {
        break;
      } else {
        continue;
      }
      g_active.fetch_add(1);
    }
    const bool reuseInput = job.encodedBytes && !job.encodedBytes->empty();
    if (!reuseInput) g_sourceReads.fetch_add(1);
    const bool completed = thumbnail_rebuilder::encode_one_to_cache(
        factory, job.sourcePath, g_cacheDir, g_cacheVersion,
        reuseInput ? job.encodedBytes->data() : nullptr,
        reuseInput ? job.encodedBytes->size() : 0, job.modifiedTime);
    if (completed) {
      g_completed.fetch_add(1);
      if (job.fillJob) g_fillCompleted.fetch_add(1);
    } else {
      g_failed.fetch_add(1);
      if (job.fillJob) g_fillFailed.fetch_add(1);
    }
    release_retained_input(job);
    g_active.fetch_sub(1);
  }
  if (factory) factory->Release();
  if (SUCCEEDED(com)) CoUninitialize();
}

static void configure(const std::string& cacheDir, bool enabled, int cacheVersion) {
  std::lock_guard<std::mutex> lock(g_mutex);
  g_cacheDir = cacheDir;
  g_normalizedCacheDir =
      cacheDir.empty() ? std::wstring() : thumbnail_rebuilder::normalized_windows_path(
                                               path_from_utf8(cacheDir));
  g_cacheVersion = std::max(1, cacheVersion);
  g_enabled = enabled && !cacheDir.empty();
}

static void begin_scan() {
  const WorkerPolicy policy = select_worker_policy();
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_jobs.clear();
    g_deferredJobs.clear();
    g_retainedInputBytes = 0;
    g_deferredPathBytes = 0;
    g_workerPolicy = policy;
    g_accepting = g_enabled;
    g_stopping = false;
    g_fillPhase = false;
  }
  g_queued.store(0);
  g_completed.store(0);
  g_failed.store(0);
  g_dropped.store(0);
  g_active.store(0);
  g_inputReused.store(0);
  g_inputReusedBytes.store(0);
  g_inputFallback.store(0);
  g_sourceReads.store(0);
  g_deferred.store(0);
  g_fillCompleted.store(0);
  g_fillFailed.store(0);
  g_cancelled.store(0);
  g_workers.clear();
  if (!g_enabled) return;
  for (int index = 0; index < policy.scanWorkerCount; ++index)
    g_workers.emplace_back(worker_loop);
}

static bool try_enqueue(Job&& job) {
  if (job.sourcePath.empty() || is_excluded_source(job.sourcePath) ||
      !thumbnail_rebuilder::is_jpeg_path(path_from_utf8(job.sourcePath))) {
    return false;
  }
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (!g_enabled || !g_accepting || g_stopping) {
      return false;
    }
    if (g_jobs.size() >= g_workerPolicy.queueCapacity) {
      const size_t pathBytes = job.sourcePath.size();
      if (g_deferredJobs.size() >= kMaxDeferredEntries ||
          pathBytes > kMaxDeferredPathBytes -
                          std::min(kMaxDeferredPathBytes, g_deferredPathBytes)) {
        g_dropped.fetch_add(1);
        return false;
      }
      if (job.encodedBytes && !job.encodedBytes->empty()) {
        const size_t bytes = job.encodedBytes->size();
        if (bytes <= kRetainedInputLimitBytes &&
            g_retainedInputBytes <= kRetainedInputLimitBytes - bytes) {
          g_retainedInputBytes += bytes;
          g_inputReused.fetch_add(1);
          g_inputReusedBytes.fetch_add(static_cast<int64_t>(bytes));
        } else {
          job.encodedBytes.reset();
          g_inputFallback.fetch_add(1);
        }
      }
      job.fillJob = true;
      g_deferredPathBytes += pathBytes;
      g_deferredJobs.push_back(std::move(job));
      g_deferred.fetch_add(1);
      g_queued.fetch_add(1);
      return true;
    }
    if (job.encodedBytes && !job.encodedBytes->empty()) {
      const size_t bytes = job.encodedBytes->size();
      if (bytes <= kRetainedInputLimitBytes &&
          g_retainedInputBytes <= kRetainedInputLimitBytes - bytes) {
        g_retainedInputBytes += bytes;
        g_inputReused.fetch_add(1);
        g_inputReusedBytes.fetch_add(static_cast<int64_t>(bytes));
      } else {
        job.encodedBytes.reset();
        g_inputFallback.fetch_add(1);
      }
    }
    g_jobs.push_back(std::move(job));
    g_queued.fetch_add(1);
  }
  g_ready.notify_one();
  return true;
}

static void finish_scan() {
  size_t targetWorkers = 0;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_accepting = false;
    g_fillPhase = !g_stopping && !g_deferredJobs.empty();
    targetWorkers = g_fillPhase ? static_cast<size_t>(g_workerPolicy.fillWorkerCount)
                                : g_workers.size();
  }
  while (g_workers.size() < targetWorkers) g_workers.emplace_back(worker_loop);
  g_ready.notify_all();
  for (auto& worker : g_workers)
    if (worker.joinable()) worker.join();
  g_workers.clear();
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_fillPhase = false;
  }
}

static void request_stop() {
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_stopping = true;
    g_accepting = false;
    g_fillPhase = false;
    g_cancelled.fetch_add(
        static_cast<int64_t>(g_jobs.size() + g_deferredJobs.size()));
    for (const auto& job : g_jobs) {
      if (!job.encodedBytes) continue;
      const size_t bytes = job.encodedBytes->size();
      g_retainedInputBytes = bytes >= g_retainedInputBytes ? 0 : g_retainedInputBytes - bytes;
    }
    for (const auto& job : g_deferredJobs) {
      if (!job.encodedBytes) continue;
      const size_t bytes = job.encodedBytes->size();
      g_retainedInputBytes = bytes >= g_retainedInputBytes ? 0 : g_retainedInputBytes - bytes;
    }
    g_jobs.clear();
    g_deferredJobs.clear();
    g_deferredPathBytes = 0;
  }
  g_ready.notify_all();
}

static Stats stats() {
  Stats result;
  result.queued = g_queued.load();
  result.completed = g_completed.load();
  result.failed = g_failed.load();
  result.dropped = g_dropped.load();
  result.inputReused = g_inputReused.load();
  result.inputReusedBytes = g_inputReusedBytes.load();
  result.inputFallback = g_inputFallback.load();
  result.sourceReads = g_sourceReads.load();
  result.deferred = g_deferred.load();
  result.fillCompleted = g_fillCompleted.load();
  result.fillFailed = g_fillFailed.load();
  result.cancelled = g_cancelled.load();
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    result.enabled = g_enabled;
    result.pending = static_cast<int64_t>(g_jobs.size() + g_deferredJobs.size()) +
                     g_active.load();
    result.deferredPending = static_cast<int64_t>(g_deferredJobs.size());
    result.deferredPathBytes = static_cast<int64_t>(g_deferredPathBytes);
    result.retainedInputBytes = static_cast<int64_t>(g_retainedInputBytes);
    result.scanWorkerCount = g_workerPolicy.scanWorkerCount;
    result.fillWorkerCount = g_workerPolicy.fillWorkerCount;
    result.queueCapacity = static_cast<int64_t>(g_workerPolicy.queueCapacity);
    result.logicalProcessors = g_workerPolicy.logicalProcessors;
    result.totalMemoryBytes = static_cast<int64_t>(g_workerPolicy.totalMemoryBytes);
    result.availableMemoryBytes =
        static_cast<int64_t>(g_workerPolicy.availableMemoryBytes);
    result.workerOverride = g_workerPolicy.overridden;
    result.phase = g_fillPhase ? "fill" : (g_accepting ? "scan" : "idle");
    result.workerCount = g_fillPhase ? g_workerPolicy.fillWorkerCount
                                    : (g_accepting ? g_workerPolicy.scanWorkerCount : 0);
  }
  return result;
}

}  // namespace thumbnail_sidecar
