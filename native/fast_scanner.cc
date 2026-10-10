// fast_scanner - N-API Native Addon
// Phase: P1.4 - Multi-segment manifest + cross-segment search

#include <node_api.h>
#include <string>
#include <vector>
#include <thread>
#include <condition_variable>
#include <shared_mutex>
#include <mutex>
#include <atomic>
#include <chrono>
#include <fstream>
#include <sstream>
#include <iomanip>
#include <cstdint>
#include <cmath>
#include <cwctype>
#include <cstdlib>
#include <cstring>
#include <algorithm>
#include <deque>
#include <filesystem>
#include <functional>
#include <unordered_set>
#include <unordered_map>
#include <queue>
#include <intrin.h>
#include <sys/stat.h>
#define WIN32_LEAN_AND_MEAN
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <winioctl.h>
#include <excpt.h>
#include <wincodec.h>   // Windows Imaging Component (WIC) for JPEG decode
#pragma comment(lib, "windowscodecs.lib")
#include "image_decode_limits.h"
namespace fs = std::filesystem;

// ===== Helpers =====
static void set_string(napi_env env, napi_value obj, const char* key, const char* val) {
  napi_value v; napi_create_string_utf8(env, val, NAPI_AUTO_LENGTH, &v); napi_set_named_property(env, obj, key, v);
}
static void set_bool(napi_env env, napi_value obj, const char* key, bool val) {
  napi_value v; napi_get_boolean(env, val, &v); napi_set_named_property(env, obj, key, v);
}
static void set_int64(napi_env env, napi_value obj, const char* key, int64_t val) {
  napi_value v; napi_create_int64(env, val, &v); napi_set_named_property(env, obj, key, v);
}
static void set_int32(napi_env env, napi_value obj, const char* key, int32_t val) {
  napi_value v; napi_create_int32(env, val, &v); napi_set_named_property(env, obj, key, v);
}
static void set_double(napi_env env, napi_value obj, const char* key, double val) {
  napi_value v; napi_create_double(env, val, &v); napi_set_named_property(env, obj, key, v);
}
static std::string get_string(napi_env env, napi_value v) {
  size_t len = 0; napi_get_value_string_utf8(env, v, nullptr, 0, &len);
  std::string s(len, '\0'); napi_get_value_string_utf8(env, v, &s[0], len + 1, &len); return s;
}
static std::wstring utf8_to_wide(const std::string& s) {
  if(s.empty())return {};int n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s.data(),(int)s.size(),nullptr,0);if(n<=0)return std::wstring(s.begin(),s.end());
  std::wstring w(n,L'\0');MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s.data(),(int)s.size(),w.data(),n);return w;
}
static fs::path path_from_utf8(const std::string& s){return fs::path(utf8_to_wide(s));}
static std::string wide_to_utf8(const std::wstring& w) {
  if(w.empty())return {};int n=WideCharToMultiByte(CP_UTF8,0,w.data(),(int)w.size(),nullptr,0,nullptr,nullptr);std::string s(n,'\0');WideCharToMultiByte(CP_UTF8,0,w.data(),(int)w.size(),s.data(),n,nullptr,nullptr);return s;
}
static int32_t get_int32(napi_env env, napi_value v) { int32_t x=0; napi_get_value_int32(env, v, &x); return x; }
static double get_double(napi_env env, napi_value v) { double x=0; napi_get_value_double(env, v, &x); return x; }
static napi_value native_error(napi_env env, const char* msg) {
  napi_value r; napi_create_object(env, &r); set_bool(env, r, "ok", false); set_string(env, r, "error", msg); return r;
}
static std::vector<std::string> split_scan_roots(const std::string& encoded) {
  std::vector<std::string> roots;size_t start=0;
  while(start<=encoded.size()){size_t end=encoded.find('\x1f',start);std::string root=encoded.substr(start,end==std::string::npos?std::string::npos:end-start);if(!root.empty())roots.push_back(root);if(end==std::string::npos)break;start=end+1;}
  return roots;
}

// ===== Image hashing =====
#define STBI_MAX_DIMENSIONS 32768
#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"
#define STB_IMAGE_RESIZE_IMPLEMENTATION
#include "stb_image_resize2.h"
#include "thumbnail_rebuilder.h"
#include "thumbnail_sidecar.h"
#include "rotating_logger.h"
static thread_local std::string g_decodeFailureReason;

static bool seh_info_call(const uint8_t* data, int len, int& width, int& height, int& channels) {
  __try {
    return stbi_info_from_memory(data, len, &width, &height, &channels) != 0;
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    width = 0;
    height = 0;
    channels = 0;
    return false;
  }
}

static bool validate_decode_dimensions(uint64_t width, uint64_t height, uint64_t channels,
                                       bool enforceDecodedBudget) {
  const auto validation =
      image_decode_limits::validate(width, height, channels, enforceDecodedBudget);
  if (!validation.ok) g_decodeFailureReason = validation.reason;
  return validation.ok;
}

static bool inspect_stb_decode_budget(const uint8_t* data, size_t len, int& width, int& height,
                                      int& channels) {
  g_decodeFailureReason.clear();
  if (!data || len == 0 || len > static_cast<size_t>(std::numeric_limits<int>::max())) {
    g_decodeFailureReason = "encoded image size exceeds the decoder limit";
    return false;
  }
  if (!seh_info_call(data, static_cast<int>(len), width, height, channels)) {
    const char* reason = stbi_failure_reason();
    g_decodeFailureReason = reason ? reason : "image header is invalid";
    return false;
  }
  return validate_decode_dimensions(static_cast<uint64_t>(width), static_cast<uint64_t>(height),
                                    static_cast<uint64_t>(channels), true);
}

static const char* decode_failure_reason() {
  if (!g_decodeFailureReason.empty()) return g_decodeFailureReason.c_str();
  const char* reason = stbi_failure_reason();
  return reason ? reason : "image decode failed";
}
static uint64_t compute_diffhash64(const uint8_t* gray, int w, int h) {
  uint8_t tiny[9*8]; stbir_resize_uint8_linear(gray,w,h,w,tiny,9,8,9,STBIR_1CHANNEL);
  uint64_t hash=0; for(int y=0;y<8;y++)for(int x=0;x<8;x++)if(tiny[y*9+x]<tiny[y*9+x+1])hash|=(1ULL<<(y*8+x)); return hash;
}

// ── DctHash64 (P1-B) ──────────────────────────────────
// 1. Resize grayscale to 32×32 via stbir
// 2. 2D DCT-II on 32×32 block using precomputed integer cos table
// 3. Extract top-left 8×8 low-frequency coefficients
// 4. Exclude DC (index 0), use 63 AC absolute values
// 5. Median of 63 AC values → threshold
// 6. Each AC abs(coeff) > median → set corresponding bit
// Returns 64-bit hash where bit[0] (DC) is always 0.
//
// Cos table is initialized once with floating-point cos() at first call;
// all subsequent hash computations use integer table lookups only.
// 1/sqrt(2) normalization for k=0 uses integer constant INV_SQRT2_SCALE.

static const int32_t (&dct_cos_table())[32][32] {
  static int32_t table[32][32];
  static std::once_flag flag;
  std::call_once(flag, [] {
    static constexpr double PI = 3.14159265358979323846;
    static constexpr int N = 32;
    static constexpr int SCALE = 256;
    for (int k = 0; k < N; k++) {
      for (int n = 0; n < N; n++) {
        double angle = PI * k * (2 * n + 1) / (2.0 * N);
        table[k][n] = (int32_t)std::lround(cos(angle) * SCALE);
      }
    }
  });
  return table;
}

static uint64_t compute_dcthash64(const uint8_t* gray, int w, int h) {
  // Step 1: resize to 32×32
  uint8_t tiny[32*32];
  stbir_resize_uint8_linear(gray, w, h, w, tiny, 32, 32, 32, STBIR_1CHANNEL);

  // Step 2: 2D DCT-II via separable 1D DCT (integer table, no runtime float)
  static constexpr int N = 32;
  static constexpr int SCALE = 256;
  static constexpr int INV_SQRT2_SCALE = 181; // round(256 / sqrt(2))
  const auto& cosTbl = dct_cos_table();
  int32_t coeff[N][N];  // intermediate buffer
  int32_t dct[N][N];    // final 2D DCT output

  // Row-wise 1D DCT-II
  for (int y = 0; y < N; y++) {
    for (int k = 0; k < N; k++) {
      int64_t sum = 0;
      const int32_t* row = cosTbl[k];
      for (int n = 0; n < N; n++) {
        sum += (int64_t)tiny[y * N + n] * row[n];
      }
      coeff[y][k] = (int32_t)(sum / SCALE);
      if (k == 0) coeff[y][k] = (int32_t)(((int64_t)coeff[y][k] * INV_SQRT2_SCALE) / SCALE);
    }
  }

  // Column-wise 1D DCT-II
  for (int x = 0; x < N; x++) {
    for (int k = 0; k < N; k++) {
      int64_t sum = 0;
      const int32_t* col = cosTbl[k];
      for (int n = 0; n < N; n++) {
        sum += (int64_t)coeff[n][x] * col[n];
      }
      dct[k][x] = (int32_t)(sum / SCALE);
      if (k == 0) dct[k][x] = (int32_t)(((int64_t)dct[k][x] * INV_SQRT2_SCALE) / SCALE);
    }
  }

  // Step 3: Extract top-left 8×8 low-frequency coefficients
  // Step 4: Exclude DC (dct[0][0]), collect 63 AC absolute values
  int32_t ac[63];
  int idx = 0;
  for (int y = 0; y < 8; y++) {
    for (int x = 0; x < 8; x++) {
      if (y == 0 && x == 0) continue; // skip DC
      ac[idx++] = std::abs(dct[y][x]);
    }
  }

  // Step 5: Median of 63 AC absolute values
  std::sort(ac, ac + 63);
  int32_t median = ac[31]; // 63 elements → index 31 is median

  // Step 6: Generate 64-bit hash
  // bit 0 (DC) = 0, bits 1-63 set if abs(coeff) > median
  uint64_t hash = 0;
  idx = 0;
  for (int y = 0; y < 8; y++) {
    for (int x = 0; x < 8; x++) {
      if (y == 0 && x == 0) { idx++; continue; }
      if ((int64_t)std::abs(dct[y][x]) > median) {
        hash |= (1ULL << idx);
      }
      idx++;
    }
  }
  return hash;
}

// ── DiffHash256 (P5) ──────────────────────────────────
// 17×16 pixel grid → 256-bit hash (4× uint64_t)
// Returns via uint64_t[4] out parameter.
static void compute_diffhash256(const uint8_t* gray, int w, int h, uint64_t out[4]){
  uint8_t tiny[17*16];
  stbir_resize_uint8_linear(gray,w,h,w,tiny,17,16,17,STBIR_1CHANNEL);
  uint64_t h0=0,h1=0,h2=0,h3=0;
  for(int y=0;y<16;y++)for(int x=0;x<16;x++){
    int bit=y*16+x;
    if(tiny[y*17+x]<tiny[y*17+x+1]){
      if(bit<64)h0|=(1ULL<<bit);
      else if(bit<128)h1|=(1ULL<<(bit-64));
      else if(bit<192)h2|=(1ULL<<(bit-128));
      else h3|=(1ULL<<(bit-192));
    }
  }
  out[0]=h0;out[1]=h1;out[2]=h2;out[3]=h3;
}

static std::string hex256(const uint64_t h[4]){
  std::ostringstream o;o<<std::hex<<std::setfill('0');
  o<<std::setw(16)<<h[0]<<std::setw(16)<<h[1]<<std::setw(16)<<h[2]<<std::setw(16)<<h[3];
  return o.str();
}

static void to_grayscale(const uint8_t* src, uint8_t* dst, int w, int h, int ch) {
  for(int i=0;i<w*h;i++){int idx=i*ch;dst[i]=(uint8_t)((src[idx]*77+src[idx+1]*150+src[idx+2]*29)>>8);}
}
static std::string hex64(uint64_t v){std::ostringstream o;o<<std::hex<<std::setfill('0')<<std::setw(16)<<v;return o.str();}
static bool read_file_bytes(const std::string& path, std::vector<uint8_t>& out){
  std::ifstream f(path_from_utf8(path),std::ios::binary|std::ios::ate);if(!f)return false;
  auto sz=f.tellg();if(sz<=0)return false;f.seekg(0);out.resize((size_t)sz);f.read((char*)out.data(),sz);return f.good()||f.eof();
}
// ── Decode dispatch framework (P0) ─────────────────────
// DecodeKind identifies which codec path was used.
// Currently all paths route through stb_image, but the dispatch
// layer is in place so future libjpeg-turbo / libwebp integrations
// can be plugged into decode_jpeg_optimized() / decode_webp_optimized()
// without changing callers.

enum class DecodeKind : int {
  STB_JPEG = 0,
  STB_PNG  = 1,
  STB_WEBP = 2,
  STB_GIF  = 3,
  STB_BMP  = 4,
  STB_OTHER= 5,
  WIC_JPEG = 6,
  UNSUPPORTED = 7,
};

// ── Dual hash result (P1-A) ───────────────────────────
// Holds both DiffHash64 and DctHash64 from a single decode pass.
// Scan worker still uses only diffHash64; HashImage() returns both.
struct HashResultV1 {
  int width = 0;
  int height = 0;
  int channels = 0;
  uint64_t diffHash64 = 0;
  uint64_t dctHash64 = 0;
  DecodeKind decodeKind = DecodeKind::UNSUPPORTED;
};

static const char* decode_kind_name(DecodeKind k){
  switch(k){
    case DecodeKind::STB_JPEG: return "jpeg_stb";
    case DecodeKind::STB_PNG:  return "png_stb";
    case DecodeKind::STB_WEBP: return "webp_stb";
    case DecodeKind::STB_GIF:  return "gif_stb";
    case DecodeKind::STB_BMP:  return "bmp_stb";
    case DecodeKind::STB_OTHER:return "stb";
    case DecodeKind::WIC_JPEG: return "jpeg_wic";
    default: return "unsupported";
  }
}

static std::string lower_ext(const std::string& path){
  auto dot=path.find_last_of('.');
  if(dot==std::string::npos)return "";
  std::string ext=path.substr(dot);
  for(auto& c:ext)c=(char)tolower((unsigned char)c);
  return ext;
}

static bool windows_env_flag_enabled(const char* name){
  char value[8]={};
  DWORD length=GetEnvironmentVariableA(name,value,(DWORD)sizeof(value));
  return length==1&&value[0]=='1';
}

static DWORD windows_env_test_delay_ms(const char* name){
  char value[16]={};
  DWORD length=GetEnvironmentVariableA(name,value,(DWORD)sizeof(value));
  if(length==0||length>=sizeof(value))return 0;
  char* end=nullptr;unsigned long parsed=std::strtoul(value,&end,10);
  if(end==value||*end!='\0')return 0;
  return (DWORD)std::min<unsigned long>(parsed,2000);
}

// WIC's scaled JPEG pixels are intentionally shadow-only. They are not bit-for-bit
// equivalent to the full-resolution stb path used by the authoritative scan index,
// so enabling them for an interactive query can make an indexed image fail to match
// itself. Keep the candidate available for benchmarks without changing production
// hash semantics.
static bool jpeg_wic_shadow_enabled(){
  return windows_env_flag_enabled("REASONIX_NATIVE_JPEG_WIC_SHADOW");
}

static DecodeKind detect_decode_kind(const std::string& path, const uint8_t* data, size_t len){
  (void)data; (void)len;
  std::string ext=lower_ext(path);
  if(ext==".jpg"||ext==".jpeg") return DecodeKind::STB_JPEG;
  if(ext==".png")  return DecodeKind::STB_PNG;
  if(ext==".webp") return DecodeKind::STB_WEBP;
  if(ext==".gif")  return DecodeKind::STB_GIF;
  if(ext==".bmp")  return DecodeKind::STB_BMP;
  if(ext==".tif"||ext==".tiff") return DecodeKind::UNSUPPORTED;
  return DecodeKind::STB_OTHER;
}

// Core stb_image decode (all formats)
static bool decode_with_stb(const uint8_t* data, size_t len, int& w, int& h, int& ch, uint64_t& oh){
  int ww=0,hh=0,cc=0;
  if(!inspect_stb_decode_budget(data,len,ww,hh,cc))return false;
  uint8_t* img=stbi_load_from_memory(data,(int)len,&ww,&hh,&cc,0);
  if(!img)return false;w=ww;h=hh;ch=cc;std::vector<uint8_t> gray((size_t)ww*hh);
  if(cc>=3)to_grayscale(img,gray.data(),ww,hh,cc);else memcpy(gray.data(),img,ww*hh);
  stbi_image_free(img);oh=compute_diffhash64(gray.data(),ww,hh);return true;
}

// ── GrayImage — single decode, re-usable grayscale (P1-C) ─
struct GrayImage {
  int width = 0;        // decoded grayscale buffer width
  int height = 0;       // decoded grayscale buffer height
  int sourceWidth = 0;  // original image width reported to callers
  int sourceHeight = 0; // original image height reported to callers
  int channels = 0;
  std::vector<uint8_t> gray; // w*h bytes, 1-channel
};

// ── WIC JPEG decode (downsample directly to hash size) ─
// Uses Windows Imaging Component to decode JPEG with built-in scaling.
// Avoids full-resolution decode → resize, saving memory and CPU.
static bool decode_jpeg_wic(const uint8_t* data, size_t len, int targetW, int targetH,
    std::vector<uint8_t>& grayOut, int& outW, int& outH,
    int* sourceW=nullptr, int* sourceH=nullptr){
  grayOut.clear();
  HRESULT hr=CoInitializeEx(nullptr,COINIT_MULTITHREADED);
  bool comOk=(SUCCEEDED(hr));
  IWICImagingFactory* factory=nullptr;
  IWICStream* stream=nullptr;
  IWICBitmapDecoder* decoder=nullptr;
  IWICBitmapFrameDecode* frame=nullptr;
  IWICBitmapScaler* scaler=nullptr;
  IWICFormatConverter* converter=nullptr;
  auto cleanup=[&](){
    if(converter)converter->Release();
    if(scaler)scaler->Release();
    if(frame)frame->Release();
    if(decoder)decoder->Release();
    if(stream)stream->Release();
    if(factory)factory->Release();
    if(comOk&&hr!=RPC_E_CHANGED_MODE)CoUninitialize();
  };
  hr=CoCreateInstance(CLSID_WICImagingFactory,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&factory));
  if(FAILED(hr)){cleanup();return false;}
  hr=factory->CreateStream(&stream);
  if(FAILED(hr)){cleanup();return false;}
  hr=stream->InitializeFromMemory(const_cast<WICInProcPointer>(reinterpret_cast<const BYTE*>(data)),(DWORD)len);
  if(FAILED(hr)){cleanup();return false;}
  hr=factory->CreateDecoderFromStream(stream,nullptr,WICDecodeMetadataCacheOnDemand,&decoder);
  if(FAILED(hr)){cleanup();return false;}
  hr=decoder->GetFrame(0,&frame);
  if(FAILED(hr)){cleanup();return false;}
  UINT srcW=0,srcH=0;frame->GetSize(&srcW,&srcH);
  if(!validate_decode_dimensions(srcW,srcH,1,false)||
     !validate_decode_dimensions((uint64_t)targetW,(uint64_t)targetH,1,true)){
    cleanup();return false;
  }
  if(sourceW)*sourceW=(int)srcW;
  if(sourceH)*sourceH=(int)srcH;
  hr=factory->CreateBitmapScaler(&scaler);
  if(FAILED(hr)){cleanup();return false;}
  hr=scaler->Initialize(frame,(UINT)targetW,(UINT)targetH,WICBitmapInterpolationModeFant);
  if(FAILED(hr)){cleanup();return false;}
  hr=factory->CreateFormatConverter(&converter);
  if(FAILED(hr)){cleanup();return false;}
  hr=converter->Initialize(scaler,GUID_WICPixelFormat8bppGray,WICBitmapDitherTypeNone,nullptr,0.f,WICBitmapPaletteTypeCustom);
  if(FAILED(hr)){cleanup();return false;}
  UINT stride=targetW;
  grayOut.resize((size_t)targetW*targetH);
  WICRect rc={0,0,targetW,targetH};
  hr=converter->CopyPixels(&rc,stride,(UINT)grayOut.size(),grayOut.data());
  if(FAILED(hr)){cleanup();return false;}
  outW=targetW;outH=targetH;
  cleanup();
  return true;
}

// ── WIC JPEG → DiffHash64 (single pass, no full-res decode) ─
static bool decode_jpeg_optimized(const uint8_t* data, size_t len, int& w, int& h, int& ch, uint64_t& oh){
  std::vector<uint8_t> gray;
  int gw=0,gh=0,sw=0,sh=0;
  // WIC decode directly to 9×8 (diffHash target size)
  if(decode_jpeg_wic(data,len,9,8,gray,gw,gh,&sw,&sh)){
    w=sw;h=sh;ch=1;
    oh=compute_diffhash64(gray.data(),gw,gh);
    return true;
  }
  // Fallback to stb
  return decode_with_stb(data,len,w,h,ch,oh);
}

// ── WIC JPEG → dual hash (single decode, both hashes) ──
static bool decode_jpeg_wic_dual(const uint8_t* data, size_t len, HashResultV1& out){
  // Decode once at 32×32 (DCT needs 32×32, diffHash needs 9×8 → scale down from 32×32)
  std::vector<uint8_t> gray32;
  int gw=0,gh=0,sw=0,sh=0;
  if(!decode_jpeg_wic(data,len,32,32,gray32,gw,gh,&sw,&sh))return false;
  out.width=sw;out.height=sh;out.channels=1;
  out.diffHash64=compute_diffhash64(gray32.data(),gw,gh);
  out.dctHash64=compute_dcthash64(gray32.data(),gw,gh);
  out.decodeKind=DecodeKind::STB_JPEG;
  return true;
}

// WIC JPEG → grayscale at ~256px max (for scan path)
static bool decode_jpeg_wic_gray(const uint8_t* data, size_t len, GrayImage& out){
  HRESULT hr=CoInitializeEx(nullptr,COINIT_MULTITHREADED);
  bool comOk=(SUCCEEDED(hr));
  IWICImagingFactory* factory=nullptr;
  IWICStream* stream=nullptr;
  IWICBitmapDecoder* decoder=nullptr;
  IWICBitmapFrameDecode* frame=nullptr;
  IWICBitmapScaler* scaler=nullptr;
  IWICFormatConverter* converter=nullptr;
  auto cleanup=[&](){
    if(converter)converter->Release();
    if(scaler)scaler->Release();
    if(frame)frame->Release();
    if(decoder)decoder->Release();
    if(stream)stream->Release();
    if(factory)factory->Release();
    if(comOk&&hr!=RPC_E_CHANGED_MODE)CoUninitialize();
  };
  hr=CoCreateInstance(CLSID_WICImagingFactory,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&factory));
  if(FAILED(hr)){cleanup();return false;}
  hr=factory->CreateStream(&stream);
  if(FAILED(hr)){cleanup();return false;}
  hr=stream->InitializeFromMemory(const_cast<WICInProcPointer>(reinterpret_cast<const BYTE*>(data)),(DWORD)len);
  if(FAILED(hr)){cleanup();return false;}
  hr=factory->CreateDecoderFromStream(stream,nullptr,WICDecodeMetadataCacheOnDemand,&decoder);
  if(FAILED(hr)){cleanup();return false;}
  hr=decoder->GetFrame(0,&frame);
  if(FAILED(hr)){cleanup();return false;}
  UINT srcW=0,srcH=0;frame->GetSize(&srcW,&srcH);
  if(!validate_decode_dimensions(srcW,srcH,1,false)){cleanup();return false;}
  out.sourceWidth=(int)srcW;out.sourceHeight=(int)srcH;out.channels=3;
  UINT tw=srcW,th=srcH,maxDim=256;
  if(srcW>maxDim||srcH>maxDim){
    double scl=(double)maxDim/(srcW>srcH?srcW:srcH);
    tw=(UINT)(srcW*scl);th=(UINT)(srcH*scl);
    if(tw<9)tw=9;if(th<9)th=9;
  }
  hr=factory->CreateBitmapScaler(&scaler);
  if(FAILED(hr)){cleanup();return false;}
  hr=scaler->Initialize(frame,tw,th,WICBitmapInterpolationModeFant);
  if(FAILED(hr)){cleanup();return false;}
  hr=factory->CreateFormatConverter(&converter);
  if(FAILED(hr)){cleanup();return false;}
  hr=converter->Initialize(scaler,GUID_WICPixelFormat8bppGray,WICBitmapDitherTypeNone,nullptr,0.f,WICBitmapPaletteTypeCustom);
  if(FAILED(hr)){cleanup();return false;}
  const auto targetValidation=image_decode_limits::validate(tw,th,1,true);
  if(!targetValidation.ok){g_decodeFailureReason=targetValidation.reason;cleanup();return false;}
  out.gray.resize(targetValidation.pixels);
  WICRect rc={0,0,(INT)tw,(INT)th};
  hr=converter->CopyPixels(&rc,tw,(UINT)out.gray.size(),out.gray.data());
  if(FAILED(hr)){cleanup();return false;}
  out.width=(int)tw;out.height=(int)th;
  cleanup();
  return true;
}

// WebP stub (still routes through stb)
static bool decode_webp_optimized(const uint8_t* data, size_t len, int& w, int& h, int& ch, uint64_t& oh){
  return decode_with_stb(data,len,w,h,ch,oh);
}

// ── Unified decode + hash entry point (P0-A) ───────────
// Routes to the appropriate codec path based on file extension.
// Returns DecodeKind via out parameter so callers can report metrics.
static bool decode_and_hash_v2(const uint8_t* data, size_t len, int& w, int& h, int& ch, uint64_t& oh, DecodeKind& kind, const std::string& path){
  kind=detect_decode_kind(path,data,len);
  switch(kind){
    case DecodeKind::STB_JPEG: return decode_jpeg_optimized(data,len,w,h,ch,oh);
    case DecodeKind::STB_WEBP: return decode_webp_optimized(data,len,w,h,ch,oh);
    case DecodeKind::STB_PNG:
    case DecodeKind::STB_GIF:
    case DecodeKind::STB_BMP:
    case DecodeKind::STB_OTHER: return decode_with_stb(data,len,w,h,ch,oh);
    default: return false;
  }
}

// ── Legacy wrapper — kept for backward compatibility ────
// Calls v2 and discards the decode kind (existing callers don't use it).
static bool decode_and_hash(const uint8_t* data, size_t len, int& w, int& h, int& ch, uint64_t& oh){
  DecodeKind dummy; return decode_and_hash_v2(data,len,w,h,ch,oh,dummy,"");
}

// stb decode → grayscale only (no hash computation)
static bool decode_to_gray_stb(const uint8_t* data, size_t len, GrayImage& out){
  int ww=0,hh=0,cc=0;
  if(!inspect_stb_decode_budget(data,len,ww,hh,cc)) return false;
  uint8_t* img=stbi_load_from_memory(data,(int)len,&ww,&hh,&cc,0);
  if(!img) return false;
  const auto validation=image_decode_limits::validate((uint64_t)ww,(uint64_t)hh,(uint64_t)cc,true);
  if(!validation.ok){g_decodeFailureReason=validation.reason;stbi_image_free(img);return false;}
  size_t npixels=validation.pixels;
  out.width=ww;out.height=hh;out.sourceWidth=ww;out.sourceHeight=hh;out.channels=cc;
  out.gray.resize(npixels);
  if(cc>=3)to_grayscale(img,out.gray.data(),ww,hh,cc);
  else memcpy(out.gray.data(),img,npixels);
  stbi_image_free(img);
  return true;
}

// Format-dispatch grayscale decode (P1-C)
static bool decode_to_gray_v2(const uint8_t* data, size_t len, const std::string& path,
                               GrayImage& out, DecodeKind& kind){
  kind=detect_decode_kind(path,data,len);
  if(kind==DecodeKind::UNSUPPORTED) return false;
  // WIC fast path for JPEG: decode at ~256px max, get original dims from header
  if(kind==DecodeKind::STB_JPEG&&jpeg_wic_shadow_enabled()){
    if(decode_jpeg_wic_gray(data,len,out)){
      if(windows_env_flag_enabled("REASONIX_NATIVE_PARITY_FIELDS"))kind=DecodeKind::WIC_JPEG;
      return true;
    }
  }
  // All other formats route through stb
  return decode_to_gray_stb(data,len,out);
}

// ── Dual hash decode (P1-C) — single decode, both hashes ─
// Decodes ONCE to grayscale, computes both DiffHash64 and DctHash64
// from the same pixel data. No double-decode.
static bool decode_and_hash_dual(const uint8_t* data, size_t len, HashResultV1& out, const std::string& path){
  DecodeKind dk=detect_decode_kind(path,data,len);
  // WIC fast path for JPEG: decode directly to 32×32, skip full-res
  if(dk==DecodeKind::STB_JPEG&&jpeg_wic_shadow_enabled()){
    if(decode_jpeg_wic_dual(data,len,out))return true;
    // Fall through to stb path on failure
  }
  GrayImage gi;
  if(!decode_to_gray_v2(data,len,path,gi,dk)) return false;
  out.width=gi.sourceWidth;out.height=gi.sourceHeight;out.channels=gi.channels;
  out.diffHash64=compute_diffhash64(gi.gray.data(),gi.width,gi.height);
  out.dctHash64=compute_dcthash64(gi.gray.data(),gi.width,gi.height);
  out.decodeKind=dk;
  return true;
}
// ── File size limits (P0-B) ────────────────────────────
static constexpr size_t MAX_SCAN_IMAGE_BYTES  = 50 * 1024 * 1024;  // 50 MB
static constexpr size_t MAX_QUERY_IMAGE_BYTES = 64 * 1024 * 1024;  // 64 MB
static constexpr size_t SCAN_IMAGE_SIGNATURE_BYTES = 12;

enum class ScanCandidateReadStatus {
  OK,
  READ_FAIL,
  OVERSIZED,
  SIGNATURE_REJECTED,
};

static bool has_supported_scan_image_signature(const uint8_t* data,size_t len){
  if(!data)return false;
  const bool jpeg=len>=3&&data[0]==0xff&&data[1]==0xd8&&data[2]==0xff;
  const uint8_t pngSignature[8]={0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a};
  const bool png=len>=sizeof(pngSignature)&&std::memcmp(data,pngSignature,sizeof(pngSignature))==0;
  const bool gif=len>=6&&std::memcmp(data,"GIF87a",6)==0;
  const bool gif89=len>=6&&std::memcmp(data,"GIF89a",6)==0;
  const bool bmp=len>=2&&data[0]=='B'&&data[1]=='M';
  const bool webp=len>=12&&std::memcmp(data,"RIFF",4)==0&&std::memcmp(data+8,"WEBP",4)==0;
  return jpeg||png||gif||gif89||bmp||webp;
}

static ScanCandidateReadStatus read_scan_image_candidate(const std::string& path,
    std::vector<uint8_t>& out,int64_t& fileSize){
  out.clear();fileSize=0;
  std::ifstream f(path_from_utf8(path),std::ios::binary|std::ios::ate);
  if(!f)return ScanCandidateReadStatus::READ_FAIL;
  auto end=f.tellg();
  if(end<0)return ScanCandidateReadStatus::READ_FAIL;
  const auto size=static_cast<size_t>(end);fileSize=static_cast<int64_t>(size);
  if(size>MAX_SCAN_IMAGE_BYTES)return ScanCandidateReadStatus::OVERSIZED;
  f.seekg(0);
  uint8_t header[SCAN_IMAGE_SIGNATURE_BYTES]={};
  const auto headerSize=std::min(size,SCAN_IMAGE_SIGNATURE_BYTES);
  if(headerSize>0){
    f.read(reinterpret_cast<char*>(header),static_cast<std::streamsize>(headerSize));
    if(static_cast<size_t>(f.gcount())!=headerSize)return ScanCandidateReadStatus::READ_FAIL;
  }
  if(!has_supported_scan_image_signature(header,headerSize))return ScanCandidateReadStatus::SIGNATURE_REJECTED;
  out.resize(size);
  if(headerSize>0)std::memcpy(out.data(),header,headerSize);
  const auto remaining=size-headerSize;
  if(remaining>0){
    f.read(reinterpret_cast<char*>(out.data()+headerSize),static_cast<std::streamsize>(remaining));
    if(static_cast<size_t>(f.gcount())!=remaining){out.clear();return ScanCandidateReadStatus::READ_FAIL;}
  }
  return ScanCandidateReadStatus::OK;
}

static uint64_t fnv64(const void* data, size_t len){
  const uint8_t* p=(const uint8_t*)data;uint64_t h=14695981039346656037ULL;
  for(size_t i=0;i<len;i++){h^=p[i];h*=1099511628211ULL;}return h;
}

// ===== ImageRecord =====
struct ImageRecord{int64_t id;std::string path;int width,height,channels;int64_t fileSize,modifiedTime;uint64_t diffHash64;uint64_t dctHash64;};
static constexpr int kMinScanWorkerCount=2;
static constexpr int kMaxScanWorkerCount=8;
static constexpr size_t kScanQueueEntriesPerWorker=32;
static constexpr size_t kMinScanQueueCapacity=64;
static constexpr size_t kMaxScanQueueCapacity=256;

struct ScanWorkerPolicy{
  int workerCount=kMinScanWorkerCount;
  size_t queueCapacity=kMinScanQueueCapacity;
  uint32_t logicalProcessors=0;
  uint64_t totalMemoryBytes=0;
  uint64_t availableMemoryBytes=0;
  bool overridden=false;
};

static int scan_memory_worker_cap(uint64_t totalBytes,uint64_t availableBytes){
  constexpr uint64_t GiB=1024ULL*1024ULL*1024ULL;
  int totalCap=kMaxScanWorkerCount;
  if(totalBytes>0&&totalBytes<6*GiB)totalCap=2;
  else if(totalBytes>0&&totalBytes<10*GiB)totalCap=3;
  else if(totalBytes>0&&totalBytes<14*GiB)totalCap=4;
  int availableCap=kMaxScanWorkerCount;
  if(availableBytes>0&&availableBytes<2*GiB)availableCap=2;
  else if(availableBytes>0&&availableBytes<4*GiB)availableCap=3;
  else if(availableBytes>0&&availableBytes<6*GiB)availableCap=4;
  return std::min(totalCap,availableCap);
}

static ScanWorkerPolicy select_scan_worker_policy(){
  ScanWorkerPolicy result;
  result.logicalProcessors=std::max(1u,std::thread::hardware_concurrency());
  MEMORYSTATUSEX memory{};memory.dwLength=sizeof(memory);
  if(GlobalMemoryStatusEx(&memory)){
    result.totalMemoryBytes=memory.ullTotalPhys;
    result.availableMemoryBytes=memory.ullAvailPhys;
  }
  int cpuTarget=std::clamp((int)((result.logicalProcessors+3)/4),kMinScanWorkerCount,kMaxScanWorkerCount);
  int requested=cpuTarget;
  char overrideValue[16]={};
  DWORD overrideLength=GetEnvironmentVariableA("REASONIX_NATIVE_SCAN_WORKERS",overrideValue,(DWORD)sizeof(overrideValue));
  if(overrideLength>0&&overrideLength<sizeof(overrideValue)){
    char* end=nullptr;long parsed=std::strtol(overrideValue,&end,10);
    if(end&&*end=='\0'&&parsed>=kMinScanWorkerCount&&parsed<=kMaxScanWorkerCount){
      requested=(int)parsed;result.overridden=true;
    }
  }
  result.workerCount=std::clamp(std::min(requested,scan_memory_worker_cap(result.totalMemoryBytes,result.availableMemoryBytes)),kMinScanWorkerCount,kMaxScanWorkerCount);
  result.queueCapacity=std::clamp((size_t)result.workerCount*kScanQueueEntriesPerWorker,kMinScanQueueCapacity,kMaxScanQueueCapacity);
  return result;
}

struct ScanMetrics{
  std::atomic<int64_t> skipped{0},signatureRejected{0},warnings{0},newFiles{0},skippedIndexed{0},skippedUnchanged{0},updated{0};
  std::atomic<int64_t> enumDirs{0},enumFiles{0},enumImages{0},enumSkippedDirs{0};
  std::atomic<int64_t> enumUs{0},filesystemEnumUs{0},queueWaitUs{0},readUs{0},normalizeUs{0},mapLookupUs{0},statUs{0},decodeUs{0},hashUs{0},pushUs{0},commitUs{0},totalUs{0};
  std::atomic<int64_t> queueSubmitCount{0},queueBlockedCount{0},readFileCount{0},readBytes{0};
  std::atomic<int> fileErrorLogCount{0};
  void reset(){
    skipped.store(0);signatureRejected.store(0);warnings.store(0);newFiles.store(0);skippedIndexed.store(0);skippedUnchanged.store(0);updated.store(0);
    enumDirs.store(0);enumFiles.store(0);enumImages.store(0);enumSkippedDirs.store(0);
    enumUs.store(0);filesystemEnumUs.store(0);queueWaitUs.store(0);readUs.store(0);normalizeUs.store(0);mapLookupUs.store(0);statUs.store(0);decodeUs.store(0);hashUs.store(0);pushUs.store(0);commitUs.store(0);totalUs.store(0);
    queueSubmitCount.store(0);queueBlockedCount.store(0);readFileCount.store(0);readBytes.store(0);
    fileErrorLogCount.store(0);
  }
};

struct IndexWriteLease;
struct AsyncCancellationToken;
struct ScanRuntime{
  std::thread thread;
  std::atomic<bool> stop{false},running{false},paused{false},stopInProgress{false};
  std::atomic<int> stopWorkCount{0};
  std::atomic<bool> stopJoinActive{false};
  std::string state="idle",error,currentPath,lastWarning,decodeBackend;
  std::mutex progressMutex,lifecycleMutex,pauseMutex,queueMutex,commitMutex;
  std::condition_variable pauseCondition,queueCondition;
  std::chrono::steady_clock::time_point startTime;
  std::atomic<int> queuePending{0},peakQueuePending{0},activeWorkers{0},peakWorkers{0};
  std::atomic<int> workerCount{kMinScanWorkerCount},queueCapacity{(int)kMinScanQueueCapacity};
  std::atomic<int64_t> workerMinCompleted{0},workerMaxCompleted{0},workerMinBusyUs{0},workerMaxBusyUs{0};
  std::atomic<int64_t> logicalProcessors{0},totalMemoryBytes{0},availableMemoryBytes{0};
  std::atomic<bool> workerOverride{false},detailedMetrics{false};
  std::atomic<bool> commitFeedEnabled{false};
  std::atomic<uint64_t> commitFeedGeneration{0};
  std::atomic<uint64_t> cancelledGeneration{0};
  // Short ownership lock only: never held while joining, collecting the index,
  // invoking N-API, or touching the global thumbnail sidecar.
  std::mutex exportOwnershipMutex;
  std::weak_ptr<IndexWriteLease> scanWriterLease;
  uint64_t scanWriterGeneration=0,scanWriterToken=0;
  std::vector<std::weak_ptr<AsyncCancellationToken>> scanExports;
  std::atomic<int> snapshotTestPhase{0};
  std::deque<std::string> committedPaths;
  size_t commitFeedMaxEntries=4096,commitFeedPendingBytes=0;
  uint64_t commitFeedDropped=0;
  ScanMetrics metrics;
};

static constexpr size_t kMinScanCommitFeedEntries=16;
static constexpr size_t kMaxScanCommitFeedEntries=4096;
static constexpr size_t kMaxScanCommitFeedBytes=8*1024*1024;
static constexpr size_t kMaxScanCommitDrainEntries=256;

static void reset_scan_commit_feed(ScanRuntime& runtime){
  std::lock_guard<std::mutex> lock(runtime.commitMutex);
  runtime.committedPaths.clear();runtime.commitFeedPendingBytes=0;runtime.commitFeedDropped=0;
  runtime.commitFeedGeneration.fetch_add(1);
}

static void record_scan_commit(ScanRuntime& runtime,const std::string& path){
  if(!runtime.commitFeedEnabled.load())return;
  std::lock_guard<std::mutex> lock(runtime.commitMutex);
  if(!runtime.commitFeedEnabled.load())return;
  if(runtime.committedPaths.size()>=runtime.commitFeedMaxEntries||
     path.size()>kMaxScanCommitFeedBytes-runtime.commitFeedPendingBytes){
    runtime.commitFeedDropped++;return;
  }
  runtime.commitFeedPendingBytes+=path.size();runtime.committedPaths.push_back(path);
}

static void request_scan_stop(ScanRuntime& runtime);

static void join_scan_thread(ScanRuntime& runtime){
  std::lock_guard<std::mutex> lifecycleLock(runtime.lifecycleMutex);
  if(runtime.thread.joinable())runtime.thread.join();
}

static void finish_scan_stop(ScanRuntime& runtime){
  runtime.running.store(false);
  runtime.paused.store(false);
  {std::lock_guard<std::mutex> lk(runtime.progressMutex);if(runtime.state!="error")runtime.state="idle";runtime.currentPath.clear();}
}

static void stop_scan_sync(ScanRuntime& runtime){
  std::lock_guard<std::mutex> lifecycleLock(runtime.lifecycleMutex);
  request_scan_stop(runtime);
  if(runtime.thread.joinable())runtime.thread.join();
  finish_scan_stop(runtime);
}

static void crash_log(const std::string& msg);

class BoundedScanPipeline{
 public:
  BoundedScanPipeline(ScanRuntime& runtime,std::function<void(const std::string&)> processor)
      :runtime_(runtime),processor_(std::move(processor)){
    const auto policy=select_scan_worker_policy();
    workerCount_=policy.workerCount;queueCapacity_=policy.queueCapacity;
    runtime_.workerCount.store(workerCount_);runtime_.queueCapacity.store((int)queueCapacity_);
    runtime_.logicalProcessors.store(policy.logicalProcessors);
    runtime_.totalMemoryBytes.store((int64_t)policy.totalMemoryBytes);
    runtime_.availableMemoryBytes.store((int64_t)policy.availableMemoryBytes);
    runtime_.workerOverride.store(policy.overridden);
    runtime_.queuePending.store(0);runtime_.peakQueuePending.store(0);runtime_.activeWorkers.store(0);runtime_.peakWorkers.store(0);
    runtime_.workerMinCompleted.store(0);runtime_.workerMaxCompleted.store(0);runtime_.workerMinBusyUs.store(0);runtime_.workerMaxBusyUs.store(0);
    workerCompleted_.assign(workerCount_,0);workerBusyUs_.assign(workerCount_,0);
    workers_.reserve(workerCount_);
    try{for(int i=0;i<workerCount_;i++)workers_.emplace_back([this,i]{worker_loop(i);});}
    catch(...){finish();throw;}
  }
  ~BoundedScanPipeline(){finish();}
  bool submit(std::string path){
    const bool detailed=runtime_.detailedMetrics.load();
    const auto waitStarted=detailed?std::chrono::high_resolution_clock::now():std::chrono::high_resolution_clock::time_point{};
    std::unique_lock<std::mutex> lock(runtime_.queueMutex);
    const bool blocked=detailed&&queue_.size()>=queueCapacity_;
    runtime_.queueCondition.wait(lock,[this]{return runtime_.stop.load()||queue_.size()<queueCapacity_;});
    if(detailed){runtime_.metrics.queueWaitUs.fetch_add(std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::high_resolution_clock::now()-waitStarted).count());
      runtime_.metrics.queueSubmitCount.fetch_add(1);if(blocked)runtime_.metrics.queueBlockedCount.fetch_add(1);}
    if(runtime_.stop.load()||finished_)return false;
    queue_.push_back(std::move(path));int pending=(int)queue_.size();runtime_.queuePending.store(pending);
    if(detailed){int peak=runtime_.peakQueuePending.load();while(pending>peak&&!runtime_.peakQueuePending.compare_exchange_weak(peak,pending)){}}
    lock.unlock();runtime_.queueCondition.notify_one();return true;
  }
  void finish(){
    {std::lock_guard<std::mutex> lock(runtime_.queueMutex);if(finished_)return;finished_=true;}
    runtime_.queueCondition.notify_all();
    for(auto& worker:workers_)if(worker.joinable())worker.join();
    workers_.clear();
    if(runtime_.detailedMetrics.load()&&!workerCompleted_.empty()){
      auto completed=std::minmax_element(workerCompleted_.begin(),workerCompleted_.end());
      auto busy=std::minmax_element(workerBusyUs_.begin(),workerBusyUs_.end());
      runtime_.workerMinCompleted.store(*completed.first);runtime_.workerMaxCompleted.store(*completed.second);
      runtime_.workerMinBusyUs.store(*busy.first);runtime_.workerMaxBusyUs.store(*busy.second);
    }
    {std::lock_guard<std::mutex> lock(runtime_.queueMutex);queue_.clear();runtime_.queuePending.store(0);}
  }
 private:
  void worker_loop(int workerIndex){
    for(;;){
      std::string path;
      {std::unique_lock<std::mutex> lock(runtime_.queueMutex);
        runtime_.queueCondition.wait(lock,[this]{return runtime_.stop.load()||finished_||!queue_.empty();});
        if(runtime_.stop.load())return;
        if(queue_.empty()){if(finished_)return;continue;}
        path=std::move(queue_.front());queue_.pop_front();runtime_.queuePending.store((int)queue_.size());
        int active=runtime_.activeWorkers.fetch_add(1)+1;int peak=runtime_.peakWorkers.load();
        while(active>peak&&!runtime_.peakWorkers.compare_exchange_weak(peak,active)){}
      }
      runtime_.queueCondition.notify_all();
      const bool detailed=runtime_.detailedMetrics.load();
      const auto busyStarted=detailed?std::chrono::high_resolution_clock::now():std::chrono::high_resolution_clock::time_point{};
      try{processor_(path);}catch(...){runtime_.metrics.skipped.fetch_add(1);crash_log("Unhandled scan pipeline exception");}
      if(detailed){workerBusyUs_[workerIndex]+=std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::high_resolution_clock::now()-busyStarted).count();
        workerCompleted_[workerIndex]++;}
      runtime_.activeWorkers.fetch_sub(1);
    }
  }
  ScanRuntime& runtime_;
  std::function<void(const std::string&)> processor_;
  std::deque<std::string> queue_;
  std::vector<std::thread> workers_;
  std::vector<int64_t> workerCompleted_,workerBusyUs_;
  int workerCount_=kMinScanWorkerCount;
  size_t queueCapacity_=kMinScanQueueCapacity;
  bool finished_=false;
};

// ===== Segment v2 structs =====
#pragma pack(push,1)
struct IdxHeader{char magic[4];uint32_t version;uint64_t recordCount,fileSize,headerSize,pathOffsetsOffset,pathBytesOffset,metadataOffset,diffHashOffset,footerOffset,bodyChecksum;};
struct IdxMeta{int32_t width,height;int64_t fileSize,modifiedTime;uint32_t flags,reserved;};
struct IdxFooter{char magic[4];uint64_t recordCount;uint32_t version;};
#pragma pack(pop)
// Must retain the exact packed 32-byte stride used by IdxMeta on disk.
// Omitting flags/reserved makes array indexing read every record after the
// first at the wrong offset.
#pragma pack(push,1)
struct IdxMetaFwd{int32_t width,height;int64_t fileSize,modifiedTime;uint32_t flags,reserved;};
#pragma pack(pop)

// ===== SegmentView =====
struct SegmentView{
  std::string id, path;
  int version=0;
  uint64_t recordCount=0, fileSize=0, bodyChecksum=0;
  HANDLE fileHandle=INVALID_HANDLE_VALUE, mappingHandle=NULL;
  const char* view=nullptr;
  const uint64_t* pathOffsets=nullptr;
  const char* pathBytes=nullptr;
  const uint8_t* metadata=nullptr;
  const uint64_t* diffHash=nullptr;
  const uint64_t* dctHash=nullptr;  // P1-D: v3 only, nullptr for v2
  const uint8_t* deletedBitmap=nullptr; // P4: v4 only, nullptr for v2/v3
  uint64_t deletedBitmapBytes=0;
  std::vector<std::vector<uint32_t>> prefix16Buckets, prefix12Buckets;
  ~SegmentView(){if(view){UnmapViewOfFile(view);}if(mappingHandle){CloseHandle(mappingHandle);}if(fileHandle!=INVALID_HANDLE_VALUE){CloseHandle(fileHandle);}}
};

// ── Global Directory (P2) ──────────────────────────────
struct GDHeader{char magic[4];uint32_t version;uint64_t subkeyCount,segmentCount,subkeyIndexOffset,entriesOffset,footerOffset,bodyChecksum;};
struct GDFooter{char magic[4];uint64_t entryCount;uint32_t version,reserved;};

// ===== Path index map for incremental scan =====
struct PathIndexEntry{int64_t fileSize=0,modifiedTime=0;bool fromSegment=false;};
struct PathKey{uint64_t first,second;bool operator==(const PathKey& other)const{return first==other.first&&second==other.second;}};
struct PathKeyHash{size_t operator()(const PathKey& key)const{return(size_t)(key.first^(key.second+0x9e3779b97f4a7c15ULL+(key.first<<6)+(key.first>>2)));}};
struct UsnVolState{std::wstring volPath;uint64_t volSerial,journalId;int64_t lastUsn,lastScanTime;};

struct ScanBackendStatus{
  std::string backend="enum",fallbackReason,fallbackCode,fallbackAction;
  int64_t win32Error=0;
};

struct IndexRuntime{
  std::atomic<int> attachedEnvs{0};
  std::shared_mutex mutex;
  std::vector<ImageRecord> records;
  std::unordered_set<std::string> dedupSet;
  std::atomic<int64_t> nextId{1},indexedCount{0},failedCount{0},totalBytes{0};
  std::atomic<bool> dirty{false};
  std::vector<std::shared_ptr<SegmentView>> segments;
  std::string mode="memory",type="linear",manifestPath;
  const char* gdView=nullptr;
  HANDLE gdFile=INVALID_HANDLE_VALUE,gdMap=NULL;
  const uint64_t* gdSubkeyIndex=nullptr;
  const char* gdEntries=nullptr;
  int gdSegmentCount=0;
  uint64_t gdSubkeyCount=0;
  std::unordered_map<PathKey,PathIndexEntry,PathKeyHash> pathIndexMap;
  std::unordered_map<std::string,std::pair<int64_t,int64_t>> failedPathMap;
  std::unordered_set<std::string> replacedPaths,deletedPaths;
  std::atomic<uint64_t> segmentGeneration{0};
  ScanBackendStatus backendStatus;
  std::mutex statusMutex;
  std::vector<UsnVolState> usnStates;
  std::string usnStatePath;
  std::mutex usnMutex;
  std::atomic<int64_t> usnRecordsRead{0},usnChangedFiles{0},usnDeletedFiles{0},usnRenamedFiles{0},usnReadMs{0};
  std::mutex writerMutex;
  uint64_t activeWriterToken=0,nextWriterToken=1;
  std::string activeWriterOperation;
  bool tryAcquireWriter(const std::string& operation,uint64_t& token,std::string& busyOperation){
    std::lock_guard<std::mutex> lock(writerMutex);
    if(activeWriterToken!=0){busyOperation=activeWriterOperation;return false;}
    token=nextWriterToken++;activeWriterToken=token;activeWriterOperation=operation;return true;
  }
  bool tryAcquireWriterAfter(uint64_t expected,const std::string& operation,uint64_t& token,std::string& error){
    std::lock_guard<std::mutex> lock(writerMutex);
    if(activeWriterToken!=0){error="Index write busy: "+activeWriterOperation;return false;}
    if(expected==0||nextWriterToken-1!=expected){error="Scan snapshot is stale: another index writer was admitted";return false;}
    token=nextWriterToken++;activeWriterToken=token;activeWriterOperation=operation;return true;
  }
  void releaseWriter(uint64_t token){
    std::lock_guard<std::mutex> lock(writerMutex);
    if(activeWriterToken==token){activeWriterToken=0;activeWriterOperation.clear();}
  }
  std::pair<bool,std::string> writerStatus(){
    std::lock_guard<std::mutex> lock(writerMutex);return{activeWriterToken!=0,activeWriterOperation};
  }
  void resetUsnScanStatus(){
    usnRecordsRead.store(0);usnChangedFiles.store(0);usnDeletedFiles.store(0);usnRenamedFiles.store(0);usnReadMs.store(0);
    std::lock_guard<std::mutex> lock(statusMutex);backendStatus=ScanBackendStatus{};
  }
  void setScanBackend(const std::string& value){std::lock_guard<std::mutex> lock(statusMutex);backendStatus.backend=value;}
  void setFallback(const std::string& reason,const std::string& code,const std::string& action,int64_t win32Error=0){
    std::lock_guard<std::mutex> lock(statusMutex);backendStatus.fallbackReason=reason;backendStatus.fallbackCode=code;
    backendStatus.fallbackAction=action;backendStatus.win32Error=win32Error;
  }
  ScanBackendStatus scanStatus(){std::lock_guard<std::mutex> lock(statusMutex);return backendStatus;}
  ~IndexRuntime();
};

static std::shared_ptr<IndexRuntime> acquire_shared_index_runtime(){
  static std::mutex serviceMutex;
  static std::weak_ptr<IndexRuntime> service;
  std::lock_guard<std::mutex> lock(serviceMutex);
  auto index=service.lock();
  if(!index){index=std::make_shared<IndexRuntime>();service=index;}
  return index;
}

struct IndexWriteLease{
  std::shared_ptr<IndexRuntime> index;
  uint64_t token=0;
  IndexWriteLease(std::shared_ptr<IndexRuntime> runtime,uint64_t writerToken):index(std::move(runtime)),token(writerToken){}
  ~IndexWriteLease(){if(index&&token)index->releaseWriter(token);}
};

static std::shared_ptr<IndexWriteLease> try_acquire_index_writer(
    const std::shared_ptr<IndexRuntime>& index,const std::string& operation,std::string& busyOperation){
  uint64_t token=0;
  if(!index->tryAcquireWriter(operation,token,busyOperation))return {};
  return std::make_shared<IndexWriteLease>(index,token);
}

static std::string index_writer_busy_error(const std::string& operation){
  return "Index write busy"+(operation.empty()?std::string():": "+operation);
}

struct AsyncCancellationToken{
  std::atomic<bool> requested{false},started{false},preCommit{false};
  void request(){requested.store(true);}
  void markStarted(){started.store(true);}
  void markPreCommit(){preCommit.store(true);}
  bool isRequested() const{return requested.load();}
  bool isStarted() const{return started.load();}
  bool isPreCommit() const{return preCommit.load();}
};

static void request_scan_stop(ScanRuntime& runtime){
  std::shared_ptr<IndexWriteLease> ownLease;
  {
    std::lock_guard<std::mutex> lock(runtime.exportOwnershipMutex);
    bool pendingExport=false;
    for(auto& weak:runtime.scanExports)if(auto token=weak.lock()){token->request();pendingExport=true;}
    if(runtime.running.load()||pendingExport)runtime.cancelledGeneration.store(runtime.commitFeedGeneration.load());
    runtime.paused.store(false);runtime.stop.store(true);
    ownLease=runtime.scanWriterLease.lock();
  }
  runtime.pauseCondition.notify_all();runtime.queueCondition.notify_all();
  // An idle old environment must not stop a newer environment's global sidecar.
  // The strong lease also closes the ownership-check -> side-effect race.
  if(ownLease)thumbnail_sidecar::request_stop();
}

struct AsyncWorkRegistryStatus{
  size_t active=0,running=0,cancellable=0,preCommit=0;
  bool closing=false;
};

class AsyncWorkRegistry{
 public:
  explicit AsyncWorkRegistry(napi_env env):env_(env){}
  bool registerWork(napi_async_work work,std::shared_ptr<AsyncCancellationToken> cancellation={}){
    std::lock_guard<std::mutex> lock(mutex_);
    if(closing_)return false;
    active_.emplace(work,std::move(cancellation));return true;
  }
  void finishWork(napi_async_work work){
    napi_async_cleanup_hook_handle completedHook=nullptr;
    {std::lock_guard<std::mutex> lock(mutex_);active_.erase(work);
     if(closing_&&active_.empty()&&cleanupHook_){completedHook=cleanupHook_;cleanupHook_=nullptr;}}
    if(completedHook)napi_remove_async_cleanup_hook(completedHook);
  }
  void beginTeardown(napi_async_cleanup_hook_handle cleanupHook){
    std::vector<napi_async_work> pending;
    {std::lock_guard<std::mutex> lock(mutex_);closing_=true;pending.reserve(active_.size());
     cleanupHook_=cleanupHook;
     for(auto& entry:active_){pending.push_back(entry.first);if(entry.second)entry.second->request();}}
    for(auto work:pending)if(napi_cancel_async_work(env_,work)==napi_ok)cancelAccepted_.fetch_add(1);
    napi_async_cleanup_hook_handle completedHook=nullptr;
    {std::lock_guard<std::mutex> lock(mutex_);if(active_.empty()&&cleanupHook_){completedHook=cleanupHook_;cleanupHook_=nullptr;}}
    if(completedHook)napi_remove_async_cleanup_hook(completedHook);
  }
  std::pair<size_t,size_t> requestCancellation(){
    std::vector<napi_async_work> pending;size_t cooperative=0,nativeAccepted=0;
    {std::lock_guard<std::mutex> lock(mutex_);pending.reserve(active_.size());
     for(auto& entry:active_){pending.push_back(entry.first);if(entry.second){entry.second->request();cooperative++;}}}
    for(auto work:pending)if(napi_cancel_async_work(env_,work)==napi_ok){nativeAccepted++;cancelAccepted_.fetch_add(1);}
    return{cooperative,nativeAccepted};
  }
  AsyncWorkRegistryStatus status() const{
    std::lock_guard<std::mutex> lock(mutex_);AsyncWorkRegistryStatus result;
    result.active=active_.size();result.closing=closing_;
    for(auto& entry:active_)if(entry.second){result.cancellable++;if(entry.second->isStarted())result.running++;
      if(entry.second->isPreCommit())result.preCommit++;}
    return result;
  }
  int64_t cancelAccepted() const{return cancelAccepted_.load();}
 private:
  napi_env env_;
  mutable std::mutex mutex_;
  std::unordered_map<napi_async_work,std::shared_ptr<AsyncCancellationToken>> active_;
  napi_async_cleanup_hook_handle cleanupHook_=nullptr;
  bool closing_=false;
  std::atomic<int64_t> cancelAccepted_{0};
};

static napi_status create_registered_async_work(
    napi_env env,const std::shared_ptr<AsyncWorkRegistry>& registry,const char* name,
    napi_async_execute_callback execute,napi_async_complete_callback complete,void* data,napi_async_work* work,
    std::shared_ptr<AsyncCancellationToken> cancellation={}){
  napi_value resourceName;
  auto status=napi_create_string_utf8(env,name,NAPI_AUTO_LENGTH,&resourceName);
  if(status!=napi_ok)return status;
  status=napi_create_async_work(env,nullptr,resourceName,execute,complete,data,work);
  if(status!=napi_ok)return status;
  if(registry->registerWork(*work,std::move(cancellation)))return napi_ok;
  napi_delete_async_work(env,*work);*work=nullptr;return napi_closing;
}

static napi_status queue_registered_async_work(
    napi_env env,const std::shared_ptr<AsyncWorkRegistry>& registry,napi_async_work* work){
  auto status=napi_queue_async_work(env,*work);
  if(status==napi_ok)return status;
  registry->finishWork(*work);napi_delete_async_work(env,*work);*work=nullptr;return status;
}

static void finish_registered_async_work(
    napi_env env,const std::shared_ptr<AsyncWorkRegistry>& registry,napi_async_work work){
  registry->finishWork(work);napi_delete_async_work(env,work);
}

static bool async_cancellation_checkpoint(
    const std::shared_ptr<AsyncCancellationToken>& cancellation,std::string& error){
  if(!cancellation||!cancellation->isRequested())return false;
  error="Async work cancelled during environment teardown";return true;
}

static void wait_at_cooperative_cancel_test_checkpoint(
    const std::shared_ptr<AsyncCancellationToken>& cancellation){
  char enabled[2]={};
  if(GetEnvironmentVariableA("FLOATING_CLOCK_NATIVE_COOPERATIVE_CANCEL_TEST",enabled,sizeof(enabled))!=1||enabled[0]!='1')return;
  auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(5);
  while(!cancellation->isRequested()&&std::chrono::steady_clock::now()<deadline)
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
}

// Per-environment immutable exports: at most two cursors, each with bounded
// record/path storage. Pages never revisit the live index or stat source files.
static constexpr size_t INDEX_EXPORT_MAX_RECORDS=1000000;
static constexpr size_t INDEX_EXPORT_MAX_BYTES=128*1024*1024;
static constexpr size_t INDEX_EXPORT_PAGE_RECORDS=256;
static constexpr size_t INDEX_EXPORT_PAGE_BYTES=256*1024;
struct ScanExportRecord{std::string path;int64_t fileSize=0,modifiedTime=0;};
struct IndexExportCursor{
  std::vector<ImageRecord> records;
  std::vector<ScanExportRecord> scanRecords;
  std::vector<std::string> paths;
  bool ready=false,pathResult=false,scanResult=false,includeParityFields=false;
  uint64_t scanGeneration=0;
  double captureMs=0,lockWaitMs=0;
  int64_t scanned=0;
};
struct StopScanAsyncData;
static std::atomic<uint64_t> nextIndexExportOwner{0};
struct AddonContext{
  std::shared_ptr<ScanRuntime> scan;
  std::shared_ptr<IndexRuntime> index;
  std::shared_ptr<AsyncWorkRegistry> asyncWorks;
  napi_async_cleanup_hook_handle asyncCleanupHook=nullptr;
  // Accessed only on this environment's JS thread; one join, many waiters.
  StopScanAsyncData* activeStop=nullptr;
  const uint64_t exportOwner=nextIndexExportOwner.fetch_add(1)+1;
  uint64_t nextExportId=0;
  std::unordered_map<std::string,std::shared_ptr<IndexExportCursor>> exports;
  AddonContext(napi_env env,std::shared_ptr<IndexRuntime> sharedIndex)
      :scan(std::make_shared<ScanRuntime>()),index(std::move(sharedIndex)),
       asyncWorks(std::make_shared<AsyncWorkRegistry>(env)){}
};

static AddonContext& get_addon_context(napi_env env){
  void* data=nullptr;
  if(napi_get_instance_data(env,&data)!=napi_ok||!data)throw std::runtime_error("FastScanner addon context is unavailable");
  return *static_cast<AddonContext*>(data);
}

static napi_value reject_index_writer_busy(napi_env env,const std::string& operation){
  napi_deferred deferred;napi_value promise,reason;
  napi_create_promise(env,&deferred,&promise);
  auto message=index_writer_busy_error(operation);
  napi_create_string_utf8(env,message.c_str(),NAPI_AUTO_LENGTH,&reason);
  napi_reject_deferred(env,deferred,reason);
  return promise;
}

// FS-07P: async entries reject instead of reading uninitialized argv[] on missing args.
static napi_value reject_missing_args(napi_env env,const char* message){
  napi_deferred deferred;napi_value promise,reason;
  napi_create_promise(env,&deferred,&promise);
  napi_create_string_utf8(env,message,NAPI_AUTO_LENGTH,&reason);
  napi_reject_deferred(env,deferred,reason);
  return promise;
}

static PathKey make_path_key(const std::string& path){
  uint64_t first=14695981039346656037ULL,second=1099511628211ULL;
  for(uint8_t value:path){first^=value;first*=1099511628211ULL;second^=(uint64_t)value+0x9e;second*=14029467366897019727ULL;}
  return{first,second};
}
static std::string normalize_path(const std::string& p){
  std::error_code ec;
  std::string r=wide_to_utf8(fs::absolute(path_from_utf8(p),ec).wstring());
  if(ec)r=p;
  std::replace(r.begin(),r.end(),'/','\\');
  for(auto& c:r)c=(char)tolower((unsigned char)c);
  while(!r.empty()&&r.back()=='\\')r.pop_back();
  return r;
}
static bool path_matches_prefix(const std::string& normalized,const std::string& prefix){
  return !prefix.empty()&&(normalized==prefix||(normalized.size()>prefix.size()&&
    normalized.compare(0,prefix.size(),prefix)==0&&normalized[prefix.size()]=='\\'));
}
static bool is_path_hidden(IndexRuntime& index,const std::string& normalizedPath){
  std::shared_lock<std::shared_mutex> lk(index.mutex);
  return index.deletedPaths.count(normalizedPath)||index.replacedPaths.count(normalizedPath);
}
static bool is_segment_path_hidden(IndexRuntime& index,const std::string& normalizedPath,int segmentId){
  std::shared_lock<std::shared_mutex> lk(index.mutex);
  if(index.deletedPaths.count(normalizedPath))return true;
  if(!index.replacedPaths.count(normalizedPath))return false;
  // Append manifests list newest segments first. A replaced path is visible only
  // from its newest segment; older copies remain physically present until compacted.
  for(int si=0;si<segmentId&&si<(int)index.segments.size();si++){
    auto& seg=index.segments[(size_t)si];if(!seg||!seg->view)continue;
    for(uint64_t i=0;i<seg->recordCount;i++){
      if(normalize_path(std::string(seg->pathBytes+seg->pathOffsets[i]))==normalizedPath)return true;
    }
  }
  return false;
}
static bool atomic_replace_file(const std::string& source,const std::string& target){
  std::wstring ws=fs::path(source).wstring(),wt=fs::path(target).wstring();
  return MoveFileExW(ws.c_str(),wt.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)!=0;
}
static std::string next_segment_id(IndexRuntime& index){
  auto now=std::chrono::system_clock::now().time_since_epoch();
  auto us=std::chrono::duration_cast<std::chrono::microseconds>(now).count();
  return std::to_string(us)+"-"+std::to_string(index.segmentGeneration.fetch_add(1));
}
static std::pair<int64_t,int64_t> file_meta(const std::string& path){
  struct _stat64 st;std::wstring wp=utf8_to_wide(path);if(_wstat64(wp.c_str(),&st)==0)return {st.st_size,st.st_mtime*1000LL};
  return {0,0};
}
static void remember_failed_path(IndexRuntime& index,const std::string& normalizedPath,const std::string& path){
  auto meta=file_meta(path);std::unique_lock<std::shared_mutex> lk(index.mutex);index.failedPathMap[normalizedPath]=meta;index.dirty.store(true);
}
static void save_failed_paths(IndexRuntime& index,const std::string& rootDir){
  std::vector<std::pair<std::string,std::pair<int64_t,int64_t>>> snap;
  {std::shared_lock<std::shared_mutex> lk(index.mutex);snap.reserve(index.failedPathMap.size());for(auto& e:index.failedPathMap)snap.push_back(e);}
  std::ofstream f(path_from_utf8(rootDir+"/failed-paths.txt"),std::ios::trunc);
  for(auto& e:snap)f<<e.second.first<<" "<<e.second.second<<" "<<std::quoted(e.first)<<"\n";
}
static std::unordered_map<std::string,std::pair<int64_t,int64_t>> read_failed_paths(const std::string& rootDir){
  std::ifstream f(path_from_utf8(rootDir+"/failed-paths.txt"));if(!f)return {};
  std::unordered_map<std::string,std::pair<int64_t,int64_t>> loaded;
  int64_t size=0,mtime=0;std::string path;
  while(f>>size>>mtime>>std::quoted(path))loaded[path]={size,mtime};
  return loaded;
}
static void load_failed_paths(IndexRuntime& index,const std::string& rootDir){
  auto loaded=read_failed_paths(rootDir);
  std::unique_lock<std::shared_mutex> lk(index.mutex);index.failedPathMap=std::move(loaded);
}

// ===== Shared USN / directory-enumeration filter =====
static bool should_skip_dir_name(const std::string& n){
  if(n.empty())return false;
  std::string lower=n;std::transform(lower.begin(),lower.end(),lower.begin(),::tolower);
  if(lower[0]=='.')return true;
  return lower=="node_modules"||lower=="$recycle.bin"||lower=="system volume information"||lower=="__pycache__"||
    lower=="venv"||lower=="dist"||lower=="build"||lower=="target"||lower=="obj"||lower=="bin"||lower=="debug"||
    lower=="release"||lower=="x64"||lower=="x86"||lower=="cppbackup"||lower=="demobackup"||lower=="backup"||
    lower=="cache"||lower=="caches"||lower=="code cache"||lower=="gpucache"||lower=="shadercache"||
    lower=="thumbcache"||lower=="crashpad"||lower=="logs"||lower=="log"||lower=="temp"||lower=="tmp"||
    lower=="windows"||lower=="program files"||lower=="program files (x86)"||lower=="programdata";
}
static bool is_image_filename(const std::string& name){
  auto dot=name.find_last_of('.');
  if(dot==std::string::npos)return false;
  std::string ext=name.substr(dot);std::transform(ext.begin(),ext.end(),ext.begin(),::tolower);
  return ext==".jpg"||ext==".jpeg"||ext==".png"||ext==".bmp"||ext==".webp"||ext==".gif";
}
template<class F>
static bool enumerate_images_win32(ScanRuntime& runtime,const std::string& rootPath,F&& onFile){
  const bool detailed=runtime.detailedMetrics.load();
  const auto enumerateStarted=detailed?std::chrono::high_resolution_clock::now():std::chrono::high_resolution_clock::time_point{};
  int64_t callbackUs=0;
  auto recordEnumeration=[&](){
    if(!detailed)return;
    const auto totalUs=std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::high_resolution_clock::now()-enumerateStarted).count();
    runtime.metrics.filesystemEnumUs.fetch_add(std::max<int64_t>(0,totalUs-callbackUs));
  };
  std::vector<std::wstring> dirs{utf8_to_wide(rootPath)};
  while(!dirs.empty()){
    if(runtime.stop.load()){recordEnumeration();return true;}
    std::wstring dir=std::move(dirs.back());dirs.pop_back();
    runtime.metrics.enumDirs.fetch_add(1);
    std::wstring pattern=dir;if(!pattern.empty()&&pattern.back()!=L'\\')pattern+=L'\\';pattern+=L'*';
    WIN32_FIND_DATAW fd={};
    HANDLE h=FindFirstFileExW(pattern.c_str(),FindExInfoBasic,&fd,FindExSearchNameMatch,nullptr,FIND_FIRST_EX_LARGE_FETCH);
    if(h==INVALID_HANDLE_VALUE&&GetLastError()==ERROR_INVALID_PARAMETER){
      h=FindFirstFileExW(pattern.c_str(),FindExInfoBasic,&fd,FindExSearchNameMatch,nullptr,0);
    }
    if(h==INVALID_HANDLE_VALUE)continue;
    do{
      if(runtime.stop.load())break;
      std::wstring wideName=fd.cFileName;std::string name=wide_to_utf8(wideName);
      if(name=="."||name=="..")continue;
      std::wstring full=dir;if(!full.empty()&&full.back()!=L'\\')full+=L'\\';full+=wideName;
      if(fd.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY){
        if(!(fd.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)&&!should_skip_dir_name(name))dirs.push_back(std::move(full));
        else runtime.metrics.enumSkippedDirs.fetch_add(1);
      }else if(is_image_filename(name)){
        runtime.metrics.enumFiles.fetch_add(1);runtime.metrics.enumImages.fetch_add(1);
        const auto callbackStarted=detailed?std::chrono::high_resolution_clock::now():std::chrono::high_resolution_clock::time_point{};
        onFile(wide_to_utf8(full));
        if(detailed)callbackUs+=std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::high_resolution_clock::now()-callbackStarted).count();
      }else{
        runtime.metrics.enumFiles.fetch_add(1);
      }
    }while(FindNextFileW(h,&fd));
    FindClose(h);
  }
  recordEnumeration();
  return true;
}

// ===== Crash log with immediate flush =====
static void se_log(const std::string& msg){rotating_logger::write(msg);}
static std::string se_path(const std::string& value){return rotating_logger::path_value(value);}
static void se_log_verbose(const std::string& msg){
  static const bool enabled=[](){const char* v=getenv("IMAGESEARCH_VERBOSE_LOG");return v&&std::string(v)=="1";}();
  if(enabled)se_log(msg);
}
static void se_log_file_error(ScanRuntime* runtime,const std::string& msg){
  if(!runtime||runtime->metrics.fileErrorLogCount.fetch_add(1)<200)se_log(msg);
}

// ===== SEH-safe raw decode (leaf function, no C++ objects) =====
struct RawDecodeResult{uint8_t* img;int w,h,c;};
static bool seh_decode_call(const uint8_t* data, int len, RawDecodeResult& out){
  __try{
    out.img=stbi_load_from_memory(data,len,&out.w,&out.h,&out.c,0);
    return out.img!=nullptr;
  }__except(EXCEPTION_EXECUTE_HANDLER){out.img=nullptr;return false;}
}

// ===== SEH-safe decode wrapper =====
static bool safe_decode_and_hash(const uint8_t* data, size_t len, int& w, int& h, int& ch, uint64_t& oh, const std::string& fp,ScanRuntime* runtime=nullptr){
  if(len>MAX_SCAN_IMAGE_BYTES){se_log_file_error(runtime,"DECODE_SKIP oversized "+se_path(fp));return false;}
  int inspectedW=0,inspectedH=0,inspectedChannels=0;
  if(!inspect_stb_decode_budget(data,len,inspectedW,inspectedH,inspectedChannels)){
    se_log_file_error(runtime,"DECODE_LIMIT "+se_path(fp)+" "+g_decodeFailureReason);return false;
  }
  auto tDec0=std::chrono::high_resolution_clock::now();
  RawDecodeResult raw={};
  if(!seh_decode_call(data,(int)len,raw)){se_log_file_error(runtime,"DECODE_AV_CRASH "+se_path(fp)+" SEH caught");return false;}
  if(!raw.img){se_log_file_error(runtime,"DECODE_FAIL "+se_path(fp)+" "+std::string(decode_failure_reason()));return false;}
  const auto validation=image_decode_limits::validate((uint64_t)raw.w,(uint64_t)raw.h,(uint64_t)raw.c,true);
  if(!validation.ok){g_decodeFailureReason=validation.reason;stbi_image_free(raw.img);se_log_file_error(runtime,"DECODE_LIMIT "+se_path(fp)+" "+g_decodeFailureReason);return false;}
  size_t npixels=validation.pixels;
  w=raw.w;h=raw.h;ch=raw.c;
  std::vector<uint8_t> gray(npixels);
  if(raw.c>=3)to_grayscale(raw.img,gray.data(),raw.w,raw.h,raw.c);else memcpy(gray.data(),raw.img,raw.w*raw.h);
  stbi_image_free(raw.img);
  auto tDec1=std::chrono::high_resolution_clock::now();
  oh=compute_diffhash64(gray.data(),raw.w,raw.h);
  auto tHash=std::chrono::high_resolution_clock::now();
  // P0-C: separate decode + hash timing
  int64_t decUs=std::chrono::duration_cast<std::chrono::microseconds>(tDec1-tDec0).count();
  int64_t hashUs=std::chrono::duration_cast<std::chrono::microseconds>(tHash-tDec1).count();
  if(runtime){runtime->metrics.decodeUs.fetch_add(decUs);runtime->metrics.hashUs.fetch_add(hashUs);}
  // P0-C: set decode backend
  DecodeKind dk=detect_decode_kind(fp,data,len);
  std::string backend=decode_kind_name(dk);
  if(runtime){std::lock_guard<std::mutex> lk(runtime->progressMutex);runtime->decodeBackend=backend;}
  se_log_verbose("DECODE_OK "+se_path(fp)+" "+std::to_string(raw.w)+"x"+std::to_string(raw.h)+" backend="+backend);
  return true;
}

// ── P1-D: SEH-safe dual hash decode ─────────────────────
// Same SEH protection as safe_decode_and_hash, but also computes dctHash64.
static bool safe_decode_and_hash_dual(const uint8_t* data, size_t len, int& w, int& h, int& ch, uint64_t& diffHash64, uint64_t& dctHash64, const std::string& fp,ScanRuntime* runtime=nullptr){
  if(len>MAX_SCAN_IMAGE_BYTES){se_log_file_error(runtime,"DECODE_SKIP oversized "+se_path(fp));return false;}
  int inspectedW=0,inspectedH=0,inspectedChannels=0;
  if(!inspect_stb_decode_budget(data,len,inspectedW,inspectedH,inspectedChannels)){
    se_log_file_error(runtime,"DECODE_LIMIT "+se_path(fp)+" "+g_decodeFailureReason);return false;
  }
  auto tDec0=std::chrono::high_resolution_clock::now();
  RawDecodeResult raw={};
  if(!seh_decode_call(data,(int)len,raw)){se_log_file_error(runtime,"DECODE_AV_CRASH "+se_path(fp)+" SEH caught");return false;}
  if(!raw.img){se_log_file_error(runtime,"DECODE_FAIL "+se_path(fp)+" "+std::string(decode_failure_reason()));return false;}
  const auto validation=image_decode_limits::validate((uint64_t)raw.w,(uint64_t)raw.h,(uint64_t)raw.c,true);
  if(!validation.ok){g_decodeFailureReason=validation.reason;stbi_image_free(raw.img);se_log_file_error(runtime,"DECODE_LIMIT "+se_path(fp)+" "+g_decodeFailureReason);return false;}
  size_t npixels=validation.pixels;
  w=raw.w;h=raw.h;ch=raw.c;
  std::vector<uint8_t> gray(npixels);
  if(raw.c>=3)to_grayscale(raw.img,gray.data(),raw.w,raw.h,raw.c);else memcpy(gray.data(),raw.img,raw.w*raw.h);
  stbi_image_free(raw.img);
  auto tDec1=std::chrono::high_resolution_clock::now();
  diffHash64=compute_diffhash64(gray.data(),raw.w,raw.h);
  dctHash64=compute_dcthash64(gray.data(),raw.w,raw.h);
  auto tHash=std::chrono::high_resolution_clock::now();
  int64_t decUs=std::chrono::duration_cast<std::chrono::microseconds>(tDec1-tDec0).count();
  int64_t hashUs=std::chrono::duration_cast<std::chrono::microseconds>(tHash-tDec1).count();
  if(runtime){runtime->metrics.decodeUs.fetch_add(decUs);runtime->metrics.hashUs.fetch_add(hashUs);}
  DecodeKind dk=detect_decode_kind(fp,data,len);
  std::string backend=decode_kind_name(dk);
  if(runtime){std::lock_guard<std::mutex> lk(runtime->progressMutex);runtime->decodeBackend=backend;}
  se_log_verbose("DECODE_OK "+se_path(fp)+" "+std::to_string(raw.w)+"x"+std::to_string(raw.h)+" backend="+backend);
  return true;
}

// ===== Crash log (legacy, delegates to se_log) =====
static void crash_log(const std::string& msg){se_log(msg);}

// ═══════════════════════════════════════════════════════════
// NTFS USN Journal Scanner (P5.0)
// ═══════════════════════════════════════════════════════════
// FSCTL_* constants are defined in winioctl.h (included via windows.h)

#pragma pack(push,1)
struct UsnRecordV2{uint32_t RecordLength;uint16_t MajorVersion,MinorVersion;uint64_t FileReferenceNumber,ParentFileReferenceNumber;int64_t Usn;uint64_t TimeStamp;uint32_t Reason;uint32_t SourceInfo;uint32_t SecurityId;uint32_t FileAttributes;uint16_t FileNameLength,FileNameOffset;WCHAR FileName[1];};
#pragma pack(pop)

struct MftEnumData{uint64_t StartFileReferenceNumber;int64_t LowUsn,HighUsn;};
struct UsnReadData{int64_t StartUsn;uint32_t ReasonMask;uint32_t ReturnOnlyOnClose;uint64_t Timeout;uint64_t BytesToWaitFor;uint64_t UsnJournalID;};
struct UsnJournalData{uint64_t UsnJournalID;int64_t FirstUsn,NextUsn,LowestValidUsn,MaxUsn;uint64_t MaximumSize,AllocationDelta;uint16_t MinMajorVersion,MaxMajorVersion;uint32_t Flags;};

static HANDLE usn_open_volume(const std::wstring& vol){
  std::wstring vp=L"\\\\.\\"+vol;if(vp.back()==L'\\')vp.pop_back();
  return CreateFileW(vp.c_str(),GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,NULL,OPEN_EXISTING,0,NULL);
}
static bool usn_query_journal(HANDLE hVol,uint64_t& journalId,int64_t& nextUsn){
  UsnJournalData jud={};DWORD br=0;
  if(!DeviceIoControl(hVol,FSCTL_QUERY_USN_JOURNAL,NULL,0,&jud,sizeof(jud),&br,NULL))return false;
  journalId=jud.UsnJournalID;nextUsn=jud.NextUsn;return true;
}
static uint64_t usn_get_path_frn(const std::string& rootPath){
  std::error_code ec;
  std::wstring rp=fs::absolute(path_from_utf8(rootPath),ec).lexically_normal().native();
  if(ec||rp.empty())return 0;
  HANDLE h=CreateFileW(rp.c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,
    NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS,NULL);
  if(h==INVALID_HANDLE_VALUE)return 0;
  BY_HANDLE_FILE_INFORMATION fi={};
  BOOL ok=GetFileInformationByHandle(h,&fi);CloseHandle(h);
  if(!ok)return 0;
  return ((uint64_t)fi.nFileIndexHigh<<32)|fi.nFileIndexLow;
}

struct UsnDirectoryNode{uint64_t parentFrn=0;std::wstring name;};
struct UsnImageNode{uint64_t parentFrn=0;std::wstring name;};

// USN enumeration is volume-wide. Collect the complete directory FRN graph first,
// then resolve each image back to the selected root FRN. This makes the result
// independent of MFT record order and prevents siblings elsewhere on the volume
// from entering a scoped scan.
static void usn_enum_files(IndexRuntime& index,HANDLE hVol,const std::string& rootPath,uint64_t rootFrn,
    std::vector<std::string>& outFiles){
  auto t0=std::chrono::high_resolution_clock::now();
  std::unordered_map<uint64_t,UsnDirectoryNode> directories;
  std::vector<UsnImageNode> images;
  std::vector<uint8_t> buf(1024*1024); // 1MB buffer
  MftEnumData med={0,0,0x7FFFFFFFFFFFFFFFLL};
  int64_t recs=0;
  for(;;){
    DWORD br=0;
    if(!DeviceIoControl(hVol,FSCTL_ENUM_USN_DATA,&med,sizeof(med),buf.data(),(DWORD)buf.size(),&br,NULL)){
      if(GetLastError()==ERROR_HANDLE_EOF)break;else{se_log("USN_ENUM_ERR code="+std::to_string(GetLastError()));break;}
    }
    if(br<sizeof(UsnRecordV2))break;
    uint8_t* p=buf.data()+8; // skip alignment padding
    uint8_t* end=buf.data()+br;
    while(p<end){
      auto* r=(UsnRecordV2*)p;if(r->RecordLength==0)break;
      if(r->MajorVersion>=2){
        std::wstring fn(r->FileName,r->FileNameLength/2);
        uint64_t frn=r->FileReferenceNumber, pfrn=r->ParentFileReferenceNumber;
        bool isDir=(r->FileAttributes&FILE_ATTRIBUTE_DIRECTORY)!=0;
        if(isDir){
          directories[frn]=UsnDirectoryNode{pfrn,std::move(fn)};
        }else if(is_image_filename(wide_to_utf8(fn)))images.push_back(UsnImageNode{pfrn,std::move(fn)});
        recs++;
      }
      if(r->RecordLength==0)break;
      p+=r->RecordLength;
    }
    if(br>=8)med.StartFileReferenceNumber=*(uint64_t*)buf.data();
  }
  std::error_code rootError;
  std::wstring root=fs::absolute(path_from_utf8(rootPath),rootError).lexically_normal().native();
  while(root.size()>3&&(root.back()==L'\\'||root.back()==L'/'))root.pop_back();
  int64_t outsideScope=0,excluded=0,unresolved=0;
  std::vector<std::wstring> segments;segments.reserve(32);
  for(auto& image:images){
    segments.clear();uint64_t current=image.parentFrn;bool withinScope=false,rejected=false;
    for(size_t depth=0;depth<4096;depth++){
      if(current==rootFrn){withinScope=true;break;}
      auto parent=directories.find(current);
      if(parent==directories.end()||parent->second.parentFrn==current){rejected=true;break;}
      if(should_skip_dir_name(wide_to_utf8(parent->second.name))){excluded++;rejected=true;break;}
      segments.push_back(parent->second.name);current=parent->second.parentFrn;
    }
    if(!withinScope){if(!rejected)unresolved++;else outsideScope++;continue;}
    std::wstring absolutePath=root;
    for(auto it=segments.rbegin();it!=segments.rend();++it){
      if(!absolutePath.empty()&&absolutePath.back()!=L'\\')absolutePath+=L'\\';absolutePath+=*it;
    }
    if(!absolutePath.empty()&&absolutePath.back()!=L'\\')absolutePath+=L'\\';absolutePath+=image.name;
    outFiles.push_back(wide_to_utf8(absolutePath));
  }
  auto t1=std::chrono::high_resolution_clock::now();
  index.usnReadMs+=std::chrono::duration_cast<std::chrono::milliseconds>(t1-t0).count();
  index.usnRecordsRead+=recs;
  index.setScanBackend("USN");
  se_log("USN_ENUM records="+std::to_string(recs)+" candidates="+std::to_string(images.size())+
    " images="+std::to_string(outFiles.size())+" outside="+std::to_string(outsideScope)+
    " excluded="+std::to_string(excluded)+" unresolved="+std::to_string(unresolved)+
    " ms="+std::to_string(index.usnReadMs));
}

// USN incremental records omit the complete parent chain. Until FRN-based path
// resolution is implemented, correctness requires the full MFT view above.

// Save USN state to usn-state.json
static void usn_save_state(IndexRuntime& index,const std::string& rootDir){
  std::lock_guard<std::mutex> lk(index.usnMutex);
  std::string fp=rootDir+"/usn-state.json";
  std::ostringstream js;js<<"{\"volumes\":[";
  for(size_t i=0;i<index.usnStates.size();i++){
    if(i>0)js<<",";
    auto& s=index.usnStates[i];
    js<<"{\"vol\":\"";for(auto c:s.volPath)js<<(char)c;
    js<<"\",\"serial\":"<<s.volSerial<<",\"journalId\":"<<s.journalId
      <<",\"lastUsn\":"<<s.lastUsn<<",\"lastScanTime\":"<<s.lastScanTime<<"}";
  }
  js<<"]}";
  std::ofstream f(path_from_utf8(fp));if(f){f<<js.str();f.close();se_log("USN_STATE_SAVED "+std::to_string(index.usnStates.size())+" volumes");}
}

// Load USN state from usn-state.json
static void usn_load_state(IndexRuntime& index,const std::string& rootDir){
  std::lock_guard<std::mutex> lk(index.usnMutex);
  index.usnStatePath=rootDir;index.usnStates.clear();
  std::string fp=rootDir+"/usn-state.json";std::vector<uint8_t> b;
  if(!read_file_bytes(fp,b))return;
  std::string js(b.begin(),b.end());
  // Minimal JSON parse
  size_t pos=0;
  while((pos=js.find("\"vol\":\"",pos))!=std::string::npos){
    pos+=7;size_t end=js.find('"',pos);if(end==std::string::npos)break;
    UsnVolState s;std::string v=js.substr(pos,end-pos);
    s.volPath=std::wstring(v.begin(),v.end());
    pos=end;
    auto nxt=[&](const char* key,uint64_t& out){
      auto p=js.find(key,pos);if(p!=std::string::npos&&p<pos+200){out=strtoull(js.c_str()+p+strlen(key),nullptr,10);}
    };
    nxt("\"serial\":",s.volSerial);nxt("\"journalId\":",s.journalId);
    nxt("\"lastUsn\":",(uint64_t&)s.lastUsn);nxt("\"lastScanTime\":",(uint64_t&)s.lastScanTime);
    index.usnStates.push_back(s);
    pos=js.find('}',pos)+1;
  }
  se_log("USN_STATE_LOADED "+std::to_string(index.usnStates.size())+" volumes from "+se_path(fp));
}

// Attempt USN scan; returns true if USN was used, false if fallback needed
static bool try_usn_scan(IndexRuntime& index,const std::string& rootPath,std::vector<std::string>& outFiles){
  outFiles.clear();index.resetUsnScanStatus();
  // P3: USN enabled by default — fallback to Win32 enum on failure
  // Extract volume from path (e.g. "C:" from "C:\Users\...")
  if(rootPath.size()<2||rootPath[1]!=':'){
    index.setFallback("not a drive path","not-drive-path","Directory paths use the safe enumeration backend.");return false;
  }
  std::wstring vol;vol+=(wchar_t)rootPath[0];vol+=L':';
  // Try USN
  HANDLE hVol=usn_open_volume(vol);
  if(hVol==INVALID_HANDLE_VALUE){
    DWORD error=GetLastError();std::string volume(vol.begin(),vol.end());
    if(error==ERROR_ACCESS_DENIED){
      index.setFallback("cannot open volume "+volume+" (access denied)","volume-access-denied",
        "Restart as administrator to enable USN, or continue with directory enumeration.",error);
    }else{
      index.setFallback("cannot open volume "+volume+" (error "+std::to_string(error)+")","volume-open-error",
        "Check that the drive is online and allows direct volume access.",error);
    }
    return false;
  }
  uint64_t journalId=0;int64_t nextUsn=0;
  if(!usn_query_journal(hVol,journalId,nextUsn)){
    DWORD error=GetLastError();CloseHandle(hVol);
    index.setFallback("USN journal query failed (error "+std::to_string(error)+")","journal-query-failed",
      "Check that the drive uses NTFS and its USN journal is available.",error);return false;
  }
  uint64_t rootFrn=usn_get_path_frn(rootPath);
  if(rootFrn==0){CloseHandle(hVol);
    index.setFallback("cannot resolve selected directory FRN","root-frn-unavailable",
      "The selected directory uses the safe enumeration backend.");return false;}
  // The old incremental reader returned bare filenames because a change record does
  // not contain the complete parent chain. A full MFT enumeration is still fast and
  // preserves absolute-path correctness; addNew filtering happens in processFile.
  usn_enum_files(index,hVol,rootPath,rootFrn,outFiles);
  CloseHandle(hVol);
  // Update USN state
  {std::lock_guard<std::mutex> lk(index.usnMutex);
   bool found=false;for(auto& s:index.usnStates){if(s.volPath==vol&&s.journalId==journalId){s.lastUsn=nextUsn;s.lastScanTime=(int64_t)std::time(nullptr);found=true;break;}}
   if(!found){UsnVolState ns;ns.volPath=vol;ns.journalId=journalId;ns.lastUsn=nextUsn;ns.lastScanTime=(int64_t)std::time(nullptr);index.usnStates.push_back(ns);}}
  index.setScanBackend("USN");
  return true;
}

// ===== Scan worker (crash-safe + scanMode + SEH + stage log) =====
static void scan_worker(ScanRuntime& runtime,IndexRuntime& index,std::string rootPath,std::string scanMode,
    std::shared_ptr<IndexWriteLease> writeLease){
  thumbnail_sidecar::begin_scan();
  try{
    {std::lock_guard<std::mutex> lk(runtime.progressMutex);runtime.state="scanning";}
    // ScanDirectory publishes running/reset-stop before starting this thread.
    // Resetting stop here could erase an immediate cancellation request.
    if(windows_env_flag_enabled("FLOATING_CLOCK_NATIVE_FAIL_SCAN_START_TEST"))throw std::runtime_error("Injected scan failure");
    {const char* detailed=getenv("REASONIX_NATIVE_STAGE_METRICS");runtime.detailedMetrics.store(detailed&&std::string(detailed)=="1");}
    runtime.metrics.reset();runtime.startTime=std::chrono::steady_clock::now();
    {std::lock_guard<std::mutex> lk(runtime.progressMutex);runtime.lastWarning.clear();runtime.decodeBackend.clear();}
    auto tScan0=std::chrono::high_resolution_clock::now();
    int64_t accEnumUs=0;
    std::atomic<int64_t> accNormUs{0},accMapUs{0},accStatUs{0},accDecUs{0},accPushUs{0};
    auto rootPaths=split_scan_roots(rootPath);
    se_log("SCAN_BEGIN roots="+std::to_string(rootPaths.size())+" mode="+scanMode);
    bool addNew=(scanMode=="addNew"),update=(scanMode=="update"),updateAll=(scanMode=="updateAll");
    bool metaOnly=(scanMode=="metaOnly"),decodeOnly=(scanMode=="decodeOnly");
    if(!addNew&&!update&&!updateAll&&!metaOnly&&!decodeOnly){addNew=true;} // default

    // ── Backend selection: USN first, fallback to directory enum ──
    // Shared file processing lambda
    auto processFile=[&](const std::string& fp){
      if(runtime.paused.load()&&!runtime.stop.load()){
        std::unique_lock<std::mutex> pauseLock(runtime.pauseMutex);
        runtime.pauseCondition.wait(pauseLock,[&runtime]{return !runtime.paused.load()||runtime.stop.load();});
      }
      if(runtime.stop.load())return;
      if(thumbnail_sidecar::is_excluded_source(fp)){runtime.metrics.skipped.fetch_add(1);return;}
      {std::lock_guard<std::mutex> lk(runtime.progressMutex);runtime.currentPath=fp;}
      se_log_verbose("SCAN_BEGIN "+se_path(fp));
      auto tNorm0=std::chrono::high_resolution_clock::now();
      std::string np=normalize_path(fp);
      auto tNorm1=std::chrono::high_resolution_clock::now();
      accNormUs.fetch_add(std::chrono::duration_cast<std::chrono::microseconds>(tNorm1-tNorm0).count());
      bool isNewFile=true,wasSegment=false;
      auto tMap0=std::chrono::high_resolution_clock::now();
      {static std::atomic<int> dbgCnt{0};int dbgIndex=dbgCnt.fetch_add(1);if(dbgIndex<5){
        std::shared_lock<std::shared_mutex> lk(index.mutex);auto pre=index.pathIndexMap.find(make_path_key(np));
        se_log_verbose("PATHDBG_"+std::to_string(dbgIndex+1)+" "+(pre!=index.pathIndexMap.end()?"HIT":"MISS")+" "+se_path(np)+" mapSize="+std::to_string(index.pathIndexMap.size()));
      }}
      if(addNew||update||updateAll){
        bool foundPath=false;PathIndexEntry existing;
        {std::shared_lock<std::shared_mutex> lk(index.mutex);
         auto it=index.pathIndexMap.find(make_path_key(np));if(it!=index.pathIndexMap.end()){foundPath=true;existing=it->second;}}
        if(foundPath){
          if(addNew){runtime.metrics.skippedIndexed.fetch_add(1);auto tMap1=std::chrono::high_resolution_clock::now();accMapUs.fetch_add(std::chrono::duration_cast<std::chrono::microseconds>(tMap1-tMap0).count());se_log_verbose("SCAN_SKIP_INDEXED "+se_path(fp));return;}
          if(update||updateAll){
            auto tStat0=std::chrono::high_resolution_clock::now();int64_t stSize=0,stMtime=0;
            try{struct _stat64 st;std::wstring wfp=utf8_to_wide(fp);if(_wstat64(wfp.c_str(),&st)==0){stSize=st.st_size;stMtime=st.st_mtime*1000LL;}}catch(...){}
            auto tStat1=std::chrono::high_resolution_clock::now();accStatUs.fetch_add(std::chrono::duration_cast<std::chrono::microseconds>(tStat1-tStat0).count());
            if(stSize>0&&existing.fileSize==stSize&&existing.modifiedTime==stMtime){runtime.metrics.skippedUnchanged.fetch_add(1);auto tMap1=std::chrono::high_resolution_clock::now();accMapUs.fetch_add(std::chrono::duration_cast<std::chrono::microseconds>(tMap1-tMap0).count());se_log_verbose("SCAN_SKIP_UNCHANGED "+se_path(fp));return;}
            isNewFile=false;wasSegment=existing.fromSegment;
          }
        }
        if(addNew){
          bool knownFailed=false;std::pair<int64_t,int64_t> failedMeta;
          {std::shared_lock<std::shared_mutex> lk(index.mutex);auto failed=index.failedPathMap.find(np);if(failed!=index.failedPathMap.end()){knownFailed=true;failedMeta=failed->second;}}
          if(knownFailed&&failedMeta==file_meta(fp)){runtime.metrics.skippedUnchanged.fetch_add(1);return;}
          if(knownFailed){std::unique_lock<std::shared_mutex> lk(index.mutex);index.failedPathMap.erase(np);}
        }
      }
      auto tMap1b=std::chrono::high_resolution_clock::now();accMapUs.fetch_add(std::chrono::duration_cast<std::chrono::microseconds>(tMap1b-tMap0).count());
      if(metaOnly){index.indexedCount.fetch_add(1);se_log_verbose("SCAN_METAOK "+se_path(fp));return;}
      std::vector<uint8_t> fb;
      int64_t fsz=0;
      const bool detailedMetrics=runtime.detailedMetrics.load();
      const auto tRead0=detailedMetrics?std::chrono::high_resolution_clock::now():std::chrono::high_resolution_clock::time_point{};
      const auto candidateStatus=read_scan_image_candidate(fp,fb,fsz);
      if(detailedMetrics){runtime.metrics.readUs.fetch_add(std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::high_resolution_clock::now()-tRead0).count());
        runtime.metrics.readFileCount.fetch_add(1);if(candidateStatus==ScanCandidateReadStatus::OK)runtime.metrics.readBytes.fetch_add(fsz);}
      if(candidateStatus==ScanCandidateReadStatus::READ_FAIL){runtime.metrics.skipped.fetch_add(1);remember_failed_path(index,np,fp);{std::lock_guard<std::mutex> lk(runtime.progressMutex);runtime.lastWarning="Read fail: "+fp;}se_log_file_error(&runtime,"READ_FAIL "+se_path(fp));return;}
      if(candidateStatus==ScanCandidateReadStatus::OVERSIZED){runtime.metrics.skipped.fetch_add(1);remember_failed_path(index,np,fp);{std::lock_guard<std::mutex> lk(runtime.progressMutex);runtime.lastWarning="Oversized: "+fp;}se_log_file_error(&runtime,"SCAN_SKIP_OVERSIZED "+se_path(fp));return;}
      if(candidateStatus==ScanCandidateReadStatus::SIGNATURE_REJECTED){runtime.metrics.skipped.fetch_add(1);runtime.metrics.signatureRejected.fetch_add(1);remember_failed_path(index,np,fp);{std::lock_guard<std::mutex> lk(runtime.progressMutex);runtime.lastWarning="Signature rejected: "+fp;}se_log_file_error(&runtime,"SCAN_SIGNATURE_REJECTED "+se_path(fp));return;}
      se_log_verbose("DECODE_BEGIN "+se_path(fp)+" size="+std::to_string(fsz));
      int w=0,h=0,ch=0;uint64_t hv=0,dctv=0;
      auto tDec0=std::chrono::high_resolution_clock::now();
      if(!safe_decode_and_hash_dual(fb.data(),fb.size(),w,h,ch,hv,dctv,fp,&runtime)){runtime.metrics.skipped.fetch_add(1);remember_failed_path(index,np,fp);{std::lock_guard<std::mutex> lk(runtime.progressMutex);runtime.lastWarning="Decode fail: "+fp;}return;}
      auto tDec1=std::chrono::high_resolution_clock::now();accDecUs.fetch_add(std::chrono::duration_cast<std::chrono::microseconds>(tDec1-tDec0).count());
      se_log_verbose("HASH_OK "+se_path(fp)+" diff="+hex64(hv)+" dct="+hex64(dctv));
      if(decodeOnly){index.indexedCount.fetch_add(1);se_log_verbose("DECODE_ONLY_OK "+se_path(fp));return;}
      int64_t mtimeMs=0;try{struct _stat64 st;std::wstring wfp=utf8_to_wide(fp);if(_wstat64(wfp.c_str(),&st)==0)mtimeMs=st.st_mtime*1000LL;}catch(...){}
      std::string dk=fp+"|"+std::to_string(mtimeMs)+"|"+std::to_string(fsz);
      {std::unique_lock<std::shared_mutex> lk(index.mutex);if(index.dedupSet.count(dk)){se_log_verbose("SCAN_DEDUP "+se_path(fp));return;}index.dedupSet.insert(dk);}
      const auto tCommit0=detailedMetrics?std::chrono::high_resolution_clock::now():std::chrono::high_resolution_clock::time_point{};
      se_log_verbose("PUSH_BEGIN "+se_path(fp));
      auto tPush0=std::chrono::high_resolution_clock::now();
      ImageRecord rec;rec.id=index.nextId.fetch_add(1);rec.path=fp;rec.width=w;rec.height=h;rec.channels=ch;
      rec.fileSize=fsz;rec.modifiedTime=mtimeMs;rec.diffHash64=hv;rec.dctHash64=dctv;
      {std::unique_lock<std::shared_mutex> lk(index.mutex);index.records.push_back(std::move(rec));index.indexedCount.fetch_add(1);index.totalBytes.fetch_add(fsz);}
      auto tPush1=std::chrono::high_resolution_clock::now();accPushUs.fetch_add(std::chrono::duration_cast<std::chrono::microseconds>(tPush1-tPush0).count());
      se_log_verbose("PUSH_OK "+se_path(fp));index.dirty.store(true);
      if(addNew||update||updateAll){PathIndexEntry pe;pe.fileSize=fsz;pe.modifiedTime=mtimeMs;pe.fromSegment=false;
        std::unique_lock<std::shared_mutex> lk(index.mutex);index.pathIndexMap[make_path_key(np)]=pe;
        if(!isNewFile&&wasSegment)index.replacedPaths.insert(np);
        // Rescanning a tombstoned path resurrects it: drop the delete marker and hide any
        // stale segment copy so only this fresh record remains visible.
        if(index.deletedPaths.erase(np)>0)index.replacedPaths.insert(np);}
      if(isNewFile){runtime.metrics.newFiles.fetch_add(1);}else{runtime.metrics.updated.fetch_add(1);}
      record_scan_commit(runtime,fp);
      if(detailedMetrics)runtime.metrics.commitUs.fetch_add(std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::high_resolution_clock::now()-tCommit0).count());
      thumbnail_sidecar::Job thumbnailJob;thumbnailJob.sourcePath=fp;thumbnailJob.modifiedTime=mtimeMs;
      if(thumbnail_sidecar::wants_encoded_input(fp))
        thumbnailJob.encodedBytes=std::make_shared<std::vector<uint8_t>>(std::move(fb));
      thumbnail_sidecar::try_enqueue(std::move(thumbnailJob));
    };

    auto processFileSafe=[&](const std::string& fp){
      try{processFile(fp);}catch(const std::exception& e){
        runtime.metrics.skipped.fetch_add(1);
        {std::lock_guard<std::mutex> lk(runtime.progressMutex);runtime.lastWarning=std::string("File error: ")+e.what();}
        crash_log(std::string("File exception: ")+e.what());
      }catch(...){
        runtime.metrics.skipped.fetch_add(1);
        {std::lock_guard<std::mutex> lk(runtime.progressMutex);runtime.lastWarning="Unknown file skip";}
        crash_log("Unknown file exception");
      }
    };
    BoundedScanPipeline pipeline(runtime,processFileSafe);

    for(const auto& scanRoot:rootPaths){
    if(runtime.stop.load())break;
    auto tEnum0=std::chrono::high_resolution_clock::now();
    std::vector<std::string> usnFiles;
    bool usnOk=false;
    if(!metaOnly&&!decodeOnly){usnOk=try_usn_scan(index,scanRoot,usnFiles);}
    if(usnOk){
      // USN backend: iterate pre-collected image paths
      index.setScanBackend("USN");
      se_log("SCAN_USN_BACKEND "+std::to_string(usnFiles.size())+" files");
      for(auto& fp:usnFiles){
        if(!pipeline.submit(std::move(fp)))break;
      }
    }else{
      // ── Fallback: directory enumeration ────────────────
      index.setScanBackend("enum");
      se_log("SCAN_ENUM_FALLBACK reason="+index.scanStatus().fallbackReason);
      std::error_code ec;
      fs::path root=path_from_utf8(scanRoot);
      if(!fs::exists(root,ec)||ec||!fs::is_directory(root,ec)||ec){
        runtime.metrics.warnings.fetch_add(1);
        {std::lock_guard<std::mutex> lk(runtime.progressMutex);runtime.lastWarning="Bad path skipped: "+scanRoot;}
        accEnumUs+=std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::high_resolution_clock::now()-tEnum0).count();
        continue;
      }
      enumerate_images_win32(runtime,scanRoot,[&](const std::string& fp){
        pipeline.submit(fp);
      });
    }
    accEnumUs+=std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::high_resolution_clock::now()-tEnum0).count();
    }
    pipeline.finish();
    // ── Store perf counters ────────────────────────────
    auto tScan1=std::chrono::high_resolution_clock::now();
    runtime.metrics.totalUs.store(std::chrono::duration_cast<std::chrono::microseconds>(tScan1-tScan0).count());
    runtime.metrics.normalizeUs.store(accNormUs.load());runtime.metrics.mapLookupUs.store(accMapUs.load());runtime.metrics.statUs.store(accStatUs.load());
    // decodeUs and hashUs are accumulated inside safe_decode_and_hash.
    // accDecUs remains a wall-time measurement for enum accounting and scan logs.
    runtime.metrics.pushUs.store(accPushUs.load());
    int64_t durMs=std::chrono::duration_cast<std::chrono::milliseconds>(tScan1-tScan0).count();
    // Producer wall time includes filesystem enumeration and bounded-queue backpressure.
    runtime.metrics.enumUs.store(accEnumUs);

    // ── Rich scan log summary ──────────────────────────
    {std::ostringstream sum;sum<<"SCAN_SUMMARY mode="<<scanMode
      <<" new="<<runtime.metrics.newFiles.load()<<" indexedIdx="<<runtime.metrics.skippedIndexed.load()
      <<" unchanged="<<runtime.metrics.skippedUnchanged.load()<<" updated="<<runtime.metrics.updated.load()
      <<" failed="<<index.failedCount.load()<<" skipped="<<runtime.metrics.skipped.load()
      <<" signatureRejected="<<runtime.metrics.signatureRejected.load()
      <<" warnings="<<runtime.metrics.warnings.load()<<" durMs="<<durMs
      <<" dirs="<<runtime.metrics.enumDirs.load()<<" files="<<runtime.metrics.enumFiles.load()<<" images="<<runtime.metrics.enumImages.load()<<" skipDirs="<<runtime.metrics.enumSkippedDirs.load()
      <<" pathMapSize="<<([&](){std::shared_lock<std::shared_mutex> lk(index.mutex);return index.pathIndexMap.size();})()
      <<" enumMs="<<(runtime.metrics.enumUs.load()/1000)<<" filesystemEnumMs="<<(runtime.metrics.filesystemEnumUs.load()/1000)
      <<" queueWaitMs="<<(runtime.metrics.queueWaitUs.load()/1000)<<" readMs="<<(runtime.metrics.readUs.load()/1000)
      <<" readBytes="<<runtime.metrics.readBytes.load()<<" normMs="<<(accNormUs.load()/1000)
      <<" mapMs="<<(accMapUs.load()/1000)<<" statMs="<<(accStatUs.load()/1000)
      <<" decodeMs="<<(accDecUs.load()/1000)<<" pushMs="<<(accPushUs.load()/1000)<<" commitMs="<<(runtime.metrics.commitUs.load()/1000)
      <<" workers="<<runtime.workerCount.load()<<" queueCapacity="<<runtime.queueCapacity.load()<<" peakWorkers="<<runtime.peakWorkers.load();
    se_log(sum.str());}
  }catch(const std::exception& e){
    {std::lock_guard<std::mutex> lk(runtime.progressMutex);runtime.error=std::string("Scan crash: ")+e.what();runtime.state="error";}
    crash_log(std::string("SCAN CRASH: ")+e.what());
  }catch(...){
    {std::lock_guard<std::mutex> lk(runtime.progressMutex);runtime.error="Unknown scan crash";runtime.state="error";}
    crash_log("SCAN CRASH: unknown exception");
  }
  thumbnail_sidecar::finish_scan();
  // Deterministic join-overlap fixture. No delay without the explicit test flag.
  if(runtime.stop.load()&&windows_env_flag_enabled("FLOATING_CLOCK_NATIVE_SCAN_STOP_JOIN_TEST"))
    std::this_thread::sleep_for(std::chrono::milliseconds(600));
  writeLease.reset();
  runtime.running.store(false);
  runtime.paused.store(false);
  runtime.pauseCondition.notify_all();
  {std::lock_guard<std::mutex> lk(runtime.progressMutex);if(runtime.state!="error")runtime.state="idle";}
}

// ===== Hamming =====
static inline int hamming64(uint64_t a,uint64_t b){return(int)__popcnt64(a^b);}

// ===== Search types =====
struct SearchHit{int64_t id;std::string path;double score;int distance;int dctDistance;int width,height;int64_t fileSize;uint64_t diffHash64;uint64_t dctHash64;int segmentId;};
struct RawCandidate{uint64_t idx;int dist;int dctDist;int segId;};
struct CompareDist{bool operator()(const RawCandidate& a,const RawCandidate& b)const{return a.dist<b.dist;}};
// Combined score: weighted mix of DiffHash and DCT distances
static double combined_score(int diffDist,int dctDist,double diffWeight=0.7,double dctWeight=0.3){
  return (64.0-diffDist)/64.0*diffWeight + (64.0-dctDist)/64.0*dctWeight;
}
struct CompareCombined{bool operator()(const RawCandidate& a,const RawCandidate& b)const{return combined_score(a.dist,a.dctDist)>combined_score(b.dist,b.dctDist);}};
struct SearchMetrics{uint64_t scanned,candidates;const char* indexType;uint64_t bucketSize;bool fallbackUsed;int segmentCount,searchedSegments;};

static bool needs_fallback(size_t got,size_t topK,const std::string& mode){if(mode=="fast")return false;if(mode=="recall"||mode=="dct")return got<topK;return got<(topK<5?topK:5);}

// ── Helper: compute dct distance and create candidate ──
static inline RawCandidate make_candidate(uint64_t idx,int diffDist,uint64_t qDct,const uint64_t* segDct,int segId){
  int dctDist=0;
  if(segDct&&qDct!=0){dctDist=hamming64(qDct,segDct[idx]);}
  return {idx,diffDist,dctDist,segId};
}

// ===== Build per-segment local index =====
static void build_segment_local_index(std::shared_ptr<SegmentView> seg){
  seg->prefix16Buckets.clear();seg->prefix16Buckets.resize(65536);
  seg->prefix12Buckets.clear();seg->prefix12Buckets.resize(4096);
  for(uint64_t i=0;i<seg->recordCount;i++){
    uint16_t p16=(uint16_t)(seg->diffHash[i]>>48),p12=(uint16_t)(seg->diffHash[i]>>52);
    if(i<=UINT32_MAX){seg->prefix16Buckets[p16].push_back((uint32_t)i);seg->prefix12Buckets[p12].push_back((uint32_t)i);}
  }
}

// ── forward declarations (P2) ──────────────────────────
static void unmap_gd(IndexRuntime& index);
static void search_all_prefix16(IndexRuntime& index,uint64_t qh,int threshold,size_t topK,std::vector<SearchHit>& out,struct SearchMetrics& m);
static SearchHit make_hit(IndexRuntime& index,const struct RawCandidate& c,bool useCombinedScore=false);

// ===== Unmap all segments =====
static void unmap_index(IndexRuntime& index){
  index.segments.clear();
  index.mode="memory";index.type="linear";index.manifestPath.clear();
  unmap_gd(index);
}

// ── Global Directory (P2) ──────────────────────────────

static void unmap_gd(IndexRuntime& index){
  if(index.gdView){UnmapViewOfFile((LPVOID)index.gdView);index.gdView=nullptr;}
  if(index.gdMap){CloseHandle(index.gdMap);index.gdMap=NULL;}
  if(index.gdFile!=INVALID_HANDLE_VALUE){CloseHandle(index.gdFile);index.gdFile=INVALID_HANDLE_VALUE;}
  index.gdSubkeyIndex=nullptr;index.gdEntries=nullptr;index.gdSegmentCount=0;index.gdSubkeyCount=0;
}

IndexRuntime::~IndexRuntime(){unmap_index(*this);}

// Build GD in memory from loaded segments
static bool build_gd_from_segments(IndexRuntime& index,std::vector<uint16_t>*& gdEntries, int& segCount){
  if(index.segments.empty()) return false;
  // Collect per-prefix16 segment set
  std::unordered_map<uint16_t,std::unordered_set<uint16_t>> prefixToSegs;
  for(size_t si=0;si<index.segments.size()&&si<65535;si++){
    auto& seg=index.segments[si];if(!seg->view||!seg->diffHash)continue;
    for(uint64_t i=0;i<seg->recordCount;i++){
      uint16_t p16=(uint16_t)(seg->diffHash[i]>>48);
      prefixToSegs[p16].insert((uint16_t)si);
    }
  }
  // Flatten to entry list: for each prefix [count, id1, id2, ...]
  std::vector<uint16_t> entries;
  std::vector<uint64_t> subkeyOffsets(65536+1);
  uint64_t entryOffset=0;
  for(int k=0;k<65536;k++){
    subkeyOffsets[k]=entryOffset;
    auto it=prefixToSegs.find((uint16_t)k);
    if(it!=prefixToSegs.end()&&!it->second.empty()){
      entries.push_back((uint16_t)it->second.size());
      for(auto sid:it->second) entries.push_back(sid);
      entryOffset+=1+it->second.size();
    }else{
      entries.push_back(0);
      entryOffset+=1;
    }
  }
  subkeyOffsets[65536]=entryOffset;
  // Build persistent entry list + subkey index
  gdEntries=new std::vector<uint16_t>(std::move(entries));
  // The subkey index needs to be stored as uint64 offsets
  // We'll build it separately during save
  segCount=(int)index.segments.size();
  return true;
}

static void save_global_directory(IndexRuntime& index,const std::string& rootDir){
  std::vector<uint16_t>* gdEntries=nullptr;int segCount=0;
  if(!build_gd_from_segments(index,gdEntries,segCount)) return;

  std::string tmpPath=rootDir+"/global_directory.tmp";
  std::string finalPath=rootDir+"/global_directory.idx";

  std::fstream f(path_from_utf8(tmpPath),std::ios::binary|std::ios::in|std::ios::out|std::ios::trunc);
  if(!f){delete gdEntries;return;}

  // Build subkey index as uint64 offsets
  std::vector<uint64_t> subkeyOffsets(65536+1);
  uint64_t entryPos=0;
  for(int k=0;k<65536;k++){
    subkeyOffsets[k]=entryPos;
    uint16_t cnt=(*gdEntries)[entryPos];
    entryPos+=1+cnt;
  }
  subkeyOffsets[65536]=entryPos;

  uint64_t subkeyIdxOff=sizeof(GDHeader);
  uint64_t entriesOff=subkeyIdxOff+(65536+1)*sizeof(uint64_t);
  uint64_t entryBytes=entryPos*sizeof(uint16_t);
  uint64_t footerOff=entriesOff+entryBytes;
  uint64_t totalSize=footerOff+sizeof(GDFooter);

  GDHeader hdr={};memcpy(hdr.magic,"IGD1",4);hdr.version=1;hdr.subkeyCount=65536;
  hdr.segmentCount=segCount;hdr.subkeyIndexOffset=subkeyIdxOff;hdr.entriesOffset=entriesOff;
  hdr.footerOffset=footerOff;hdr.bodyChecksum=0;
  f.write((const char*)&hdr,sizeof(GDHeader));
  f.write((const char*)subkeyOffsets.data(),subkeyOffsets.size()*sizeof(uint64_t));
  f.write((const char*)gdEntries->data(),entryBytes);
  uint64_t bodyStart=sizeof(GDHeader);
  uint64_t bodyEnd=(uint64_t)f.tellp();std::vector<char> bodyBuf((size_t)(bodyEnd-bodyStart));
  f.seekp(bodyStart);f.read(bodyBuf.data(),bodyBuf.size());
  uint64_t cs=fnv64(bodyBuf.data(),bodyBuf.size());
  f.seekp(offsetof(GDHeader,bodyChecksum));f.write((const char*)&cs,8);f.seekp(0,std::ios::end);
  GDFooter ftr={};memcpy(ftr.magic,"END!",4);ftr.entryCount=entryPos;ftr.version=1;
  f.write((const char*)&ftr,sizeof(GDFooter));f.close();

  // Atomic rename
  std::wstring ws=fs::path(tmpPath).wstring(),wf=fs::path(finalPath).wstring();
  MoveFileExW(ws.c_str(),wf.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH);

  delete gdEntries;
}

static bool load_global_directory(IndexRuntime& index,const std::string& rootDir){
  unmap_gd(index);
  std::string gdPath=rootDir+"/global_directory.idx";
  std::wstring wPath=utf8_to_wide(gdPath);
  HANDLE hFile=CreateFileW(wPath.c_str(),GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);
  if(hFile==INVALID_HANDLE_VALUE) return false;
  LARGE_INTEGER li;GetFileSizeEx(hFile,&li);uint64_t fsz=(uint64_t)li.QuadPart;
  HANDLE hMap=CreateFileMappingW(hFile,NULL,PAGE_READONLY,0,0,NULL);
  if(!hMap){CloseHandle(hFile);return false;}
  const char* view=(const char*)MapViewOfFile(hMap,FILE_MAP_READ,0,0,0);
  if(!view){CloseHandle(hMap);CloseHandle(hFile);return false;}
  const GDHeader* hdr=(const GDHeader*)view;
  if(memcmp(hdr->magic,"IGD1",4)||hdr->version!=1||hdr->subkeyCount!=65536){
    UnmapViewOfFile((LPVOID)view);CloseHandle(hMap);CloseHandle(hFile);return false;
  }
  if(hdr->segmentCount!=(uint64_t)index.segments.size()){
    // Segment count mismatch — GD is stale, ignore
    UnmapViewOfFile((LPVOID)view);CloseHandle(hMap);CloseHandle(hFile);return false;
  }
  const GDFooter* ftr=(const GDFooter*)(view+fsz-sizeof(GDFooter));
  if(memcmp(ftr->magic,"END!",4)){UnmapViewOfFile((LPVOID)view);CloseHandle(hMap);CloseHandle(hFile);return false;}
  index.gdView=view;index.gdFile=hFile;index.gdMap=hMap;
  index.gdSubkeyIndex=(const uint64_t*)(view+hdr->subkeyIndexOffset);
  index.gdEntries=view+hdr->entriesOffset;
  index.gdSegmentCount=(int)hdr->segmentCount;
  index.gdSubkeyCount=hdr->subkeyCount;
  return true;
}

// GD-aware search: lookup subkey → get segment list → search only those segments
static void search_all_gd(IndexRuntime& index,uint64_t qh,int threshold,size_t topK,std::vector<SearchHit>& out,SearchMetrics& m){
  out.clear();m.scanned=0;m.candidates=0;m.indexType="globalDir";m.bucketSize=0;m.fallbackUsed=false;m.searchedSegments=0;
  uint16_t qPfx=(uint16_t)(qh>>48);
  if(!index.gdSubkeyIndex||qPfx>=index.gdSubkeyCount){
    // Fallback
    search_all_prefix16(index,qh,threshold,topK,out,m);
    return;
  }
  uint64_t start=index.gdSubkeyIndex[qPfx];
  uint64_t end=(qPfx+1<index.gdSubkeyCount)?index.gdSubkeyIndex[qPfx+1]:0;
  if(end<=start){
    m.fallbackUsed=true;
    search_all_prefix16(index,qh,threshold,topK,out,m);
    return;
  }
  // Read segment list for this subkey
  std::vector<uint16_t> segIds;
  const uint16_t* entry=(const uint16_t*)(index.gdEntries+start*sizeof(uint16_t));
  uint16_t cnt=*entry;entry++;
  for(uint16_t j=0;j<cnt&&j<65535;j++){
    uint16_t sid=*entry++;
    if(sid<(uint16_t)index.segments.size()) segIds.push_back(sid);
  }
  m.segmentCount=(int)segIds.size();m.bucketSize=0;
  // Search each segment's prefix16 bucket
  std::priority_queue<RawCandidate,std::vector<RawCandidate>,CompareDist> heap;
  for(auto si:segIds){
    auto& seg=index.segments[si];if(!seg->view)continue;
    m.searchedSegments++;
    const auto& b=seg->prefix16Buckets[qPfx];if(b.empty())continue;
    m.scanned+=b.size();m.bucketSize+=b.size();
    for(uint32_t idx:b){
      int d=hamming64(qh,seg->diffHash[idx]);if(d<=threshold){m.candidates++;
        if(heap.size()<topK)heap.push({idx,d,0,(int)si});else if(d<heap.top().dist){heap.pop();heap.push({idx,d,0,(int)si});}}}
  }
  // Assemble hits
  std::vector<RawCandidate> fin;fin.reserve(heap.size());while(!heap.empty()){fin.push_back(heap.top());heap.pop();}
  std::sort(fin.begin(),fin.end(),[](auto& a,auto& b){return a.dist<b.dist;});out.reserve(fin.size());
  for(auto& c:fin){SearchHit h=make_hit(index,c);if(h.path.empty())continue;out.push_back(std::move(h));}
}

// ── Helper: assemble SearchHit from segment candidate (P2 dedup) ─
static SearchHit make_hit(IndexRuntime& index,const RawCandidate& c,bool useCombinedScore){
  auto& seg=index.segments[c.segId];
  SearchHit h;h.id=(int64_t)c.idx;h.segmentId=c.segId;
  std::string sp=std::string(seg->pathBytes+seg->pathOffsets[c.idx]);
  std::string np=normalize_path(sp);if(is_segment_path_hidden(index,np,c.segId))return h;
  h.path=sp;h.distance=c.dist;h.dctDistance=c.dctDist;
  h.score=useCombinedScore?combined_score(c.dist,c.dctDist):((64.0-c.dist)/64.0);
  auto* meta=(const IdxMetaFwd*)seg->metadata;
  h.width=meta[c.idx].width;h.height=meta[c.idx].height;h.fileSize=meta[c.idx].fileSize;
  h.diffHash64=seg->diffHash[c.idx];
  h.dctHash64=seg->dctHash?seg->dctHash[c.idx]:0;
  return h;
}

// ===== Search one segment bucket (prefix16 or prefix12) =====
static void search_segment_bucket(uint64_t qh,int threshold,size_t topK,const std::vector<uint32_t>& bucket,std::shared_ptr<SegmentView> seg,int segId,std::vector<RawCandidate>& out){
  for(uint32_t idx:bucket){int d=hamming64(qh,seg->diffHash[idx]);if(d<=threshold)out.push_back({idx,d,0,segId});}
}

// ===== Search all segments (prefix16) =====
static void search_all_prefix16(IndexRuntime& index,uint64_t qh,int threshold,size_t topK,std::vector<SearchHit>& out,SearchMetrics& m){
  out.clear();m.scanned=0;m.candidates=0;m.indexType="prefix16";m.bucketSize=0;m.searchedSegments=0;
  uint16_t qPfx=(uint16_t)(qh>>48);
  std::priority_queue<RawCandidate,std::vector<RawCandidate>,CompareDist> heap;
  for(size_t si=0;si<index.segments.size();si++){
    auto& seg=index.segments[si];if(!seg->view)continue;
    const auto& b=seg->prefix16Buckets[qPfx];if(b.empty())continue;
    m.searchedSegments++;m.scanned+=b.size();m.bucketSize+=b.size();
    for(uint32_t idx:b){int d=hamming64(qh,seg->diffHash[idx]);if(d<=threshold){m.candidates++;
      if(heap.size()<topK)heap.push({idx,d,0,(int)si});else if(d<heap.top().dist){heap.pop();heap.push({idx,d,0,(int)si});}}}
  }
  std::vector<RawCandidate> fin;fin.reserve(heap.size());while(!heap.empty()){fin.push_back(heap.top());heap.pop();}
  std::sort(fin.begin(),fin.end(),[](auto& a,auto& b){return a.dist<b.dist;});out.reserve(fin.size());
  for(auto& c:fin){SearchHit h=make_hit(index,c);if(h.path.empty())continue;out.push_back(std::move(h));}
}

// ===== Search all segments (prefix12) =====
static void search_all_prefix12(IndexRuntime& index,uint64_t qh,int threshold,size_t topK,std::vector<SearchHit>& out,SearchMetrics& m){
  out.clear();m.scanned=0;m.candidates=0;m.indexType="prefix12";m.bucketSize=0;m.fallbackUsed=true;m.searchedSegments=0;
  uint16_t qPfx=(uint16_t)(qh>>52);
  std::priority_queue<RawCandidate,std::vector<RawCandidate>,CompareDist> heap;
  for(size_t si=0;si<index.segments.size();si++){
    auto& seg=index.segments[si];if(!seg->view)continue;
    const auto& b=seg->prefix12Buckets[qPfx];if(b.empty())continue;
    m.searchedSegments++;m.scanned+=b.size();m.bucketSize+=b.size();
    for(uint32_t idx:b){int d=hamming64(qh,seg->diffHash[idx]);if(d<=threshold){m.candidates++;
      if(heap.size()<topK)heap.push({idx,d,0,(int)si});else if(d<heap.top().dist){heap.pop();heap.push({idx,d,0,(int)si});}}}
  }
  std::vector<RawCandidate> fin;fin.reserve(heap.size());while(!heap.empty()){fin.push_back(heap.top());heap.pop();}
  std::sort(fin.begin(),fin.end(),[](auto& a,auto& b){return a.dist<b.dist;});out.reserve(fin.size());
  for(auto& c:fin){SearchHit h=make_hit(index,c);if(h.path.empty())continue;out.push_back(std::move(h));}
}

// ===== Search all segments linear =====
static void search_all_linear(IndexRuntime& index,uint64_t qh,int threshold,size_t topK,std::vector<SearchHit>& out,SearchMetrics& m){
  out.clear();m.scanned=0;m.candidates=0;m.indexType="linear";m.bucketSize=0;m.fallbackUsed=true;m.searchedSegments=0;
  std::priority_queue<RawCandidate,std::vector<RawCandidate>,CompareDist> heap;
  for(size_t si=0;si<index.segments.size();si++){
    auto& seg=index.segments[si];if(!seg->view)continue;m.searchedSegments++;
    for(uint64_t i=0;i<seg->recordCount;i++){int d=hamming64(qh,seg->diffHash[i]);m.scanned++;
      if(d<=threshold){m.candidates++;if(heap.size()<topK)heap.push({i,d,0,(int)si});else if(d<heap.top().dist){heap.pop();heap.push({i,d,0,(int)si});}}}
  }
  std::vector<RawCandidate> fin;fin.reserve(heap.size());while(!heap.empty()){fin.push_back(heap.top());heap.pop();}
  std::sort(fin.begin(),fin.end(),[](auto& a,auto& b){return a.dist<b.dist;});out.reserve(fin.size());
  for(auto& c:fin){SearchHit h=make_hit(index,c);if(h.path.empty())continue;out.push_back(std::move(h));}
}

// ===== Search (memory mode via index.records) =====
static void search_memory(IndexRuntime& index,uint64_t qh,int threshold,size_t topK,std::vector<SearchHit>& out,SearchMetrics& m){
  out.clear();m.scanned=0;m.candidates=0;m.indexType=index.type.c_str();m.bucketSize=0;m.searchedSegments=0;m.segmentCount=0;
  if(topK==0)return;
  std::vector<ImageRecord> snap;{std::shared_lock<std::shared_mutex> lk(index.mutex);snap=index.records;m.scanned=snap.size();}
  std::priority_queue<RawCandidate,std::vector<RawCandidate>,CompareDist> heap;
  for(size_t i=0;i<snap.size();i++){int d=hamming64(qh,snap[i].diffHash64);if(d<=threshold){m.candidates++;
    if(heap.size()<topK)heap.push({(uint64_t)i,d,0,0});else if(d<heap.top().dist){heap.pop();heap.push({(uint64_t)i,d,0,0});}}}
  std::vector<RawCandidate> fin;fin.reserve(heap.size());while(!heap.empty()){fin.push_back(heap.top());heap.pop();}
  std::sort(fin.begin(),fin.end(),[](auto& a,auto& b){return a.dist<b.dist;});out.reserve(fin.size());
  for(auto& c:fin){auto& s=snap[c.idx];SearchHit h;h.id=s.id;h.path=s.path;h.distance=c.dist;h.dctDistance=0;h.segmentId=0;
    h.score=(64.0-c.dist)/64.0;h.width=s.width;h.height=s.height;h.fileSize=s.fileSize;h.diffHash64=s.diffHash64;h.dctHash64=s.dctHash64;out.push_back(std::move(h));}
}

// ── DCT re-ranking: re-sort hits by combined DiffHash + DCT score ─
static void re_rank_dct(std::vector<SearchHit>& hits,uint64_t qDct){
  if(qDct==0||hits.empty())return;
  for(auto& h:hits){
    if(h.dctHash64!=0){
      h.dctDistance=hamming64(qDct,h.dctHash64);
      h.score=combined_score(h.distance,h.dctDistance);
    }else{
      h.dctDistance=64;
      h.score=combined_score(h.distance,64);
    }
  }
  std::sort(hits.begin(),hits.end(),[](const SearchHit& a,const SearchHit& b){return a.score>b.score;});
}

// ===== Main search dispatch =====
static void search_by_hash(IndexRuntime& index,uint64_t qh,int threshold,size_t topK,std::vector<SearchHit>& out,SearchMetrics& m,uint64_t qDct=0,bool dctMode=false){
  if(index.mode=="segment_mmap"&&!index.segments.empty()){
    // P2: prefer Global Directory when available
    if(index.gdSubkeyIndex!=nullptr){search_all_gd(index,qh,threshold,topK,out,m);}
    else{search_all_prefix16(index,qh,threshold,topK,out,m);}
  }else{
    search_memory(index,qh,threshold,topK,out,m);
  }
  if(dctMode)re_rank_dct(out,qDct);
}
static void search_linear_by_hash(IndexRuntime& index,uint64_t qh,int threshold,size_t topK,std::vector<SearchHit>& out,SearchMetrics& m,uint64_t qDct=0,bool dctMode=false){
  if(index.mode=="segment_mmap"&&!index.segments.empty()){search_all_linear(index,qh,threshold,topK,out,m);}
  else{search_memory(index,qh,threshold,topK,out,m);}
  if(dctMode)re_rank_dct(out,qDct);
}
static void search_balanced_by_hash(IndexRuntime& index,uint64_t qh,int threshold,size_t topK,std::vector<SearchHit>& out,SearchMetrics& m,uint64_t qDct=0,bool dctMode=false){
  search_linear_by_hash(index,qh,threshold,topK,out,m,qDct,dctMode);
  m.indexType="linear-balanced";m.fallbackUsed=true;
}

// ===== N-API wrappers =====
static napi_value GetNativeVersion(napi_env env,napi_callback_info){napi_value r;napi_create_string_utf8(env,"fast_scanner 0.5.38",NAPI_AUTO_LENGTH,&r);return r;}
static napi_value GetNativeStatus(napi_env env,napi_callback_info){
  auto& context=get_addon_context(env);auto& scan=*context.scan;auto asyncStatus=context.asyncWorks->status();
  const auto workerPolicy=select_scan_worker_policy();
  const auto thumbnailWorkerPolicy=thumbnail_sidecar::select_worker_policy();
  napi_value r,v;napi_create_object(env,&r);napi_get_boolean(env,true,&v);napi_set_named_property(env,r,"connected",v);
  napi_create_string_utf8(env,"0.5.38",NAPI_AUTO_LENGTH,&v);napi_set_named_property(env,r,"version",v);
  napi_value feats,f;napi_create_array_with_length(env,32,&feats);
  napi_create_string_utf8(env,"hash",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,0,f);
  napi_create_string_utf8(env,"scan",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,1,f);
  napi_create_string_utf8(env,"segment-v4",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,2,f);
  napi_create_string_utf8(env,"manifest",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,3,f);
  napi_create_string_utf8(env,"usn",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,4,f);
  napi_create_string_utf8(env,"exact-balanced",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,5,f);
  napi_create_string_utf8(env,"append-segment",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,6,f);
  napi_create_string_utf8(env,"dct-rank",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,7,f);
  napi_create_string_utf8(env,"scan-thumbnail-sidecar",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,8,f);
  napi_create_string_utf8(env,"native-thumbnail-rebuild",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,9,f);
  napi_create_string_utf8(env,"async-stop",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,10,f);
  napi_create_string_utf8(env,"bounded-scan-pipeline",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,11,f);
  napi_create_string_utf8(env,"scan-runtime-context",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,12,f);
  napi_create_string_utf8(env,"scan-metrics-context",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,13,f);
  napi_create_string_utf8(env,"index-runtime-context",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,14,f);
  napi_create_string_utf8(env,"addon-context",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,15,f);
  napi_create_string_utf8(env,"scan-index-injection",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,16,f);
  napi_create_string_utf8(env,"search-index-injection",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,17,f);
  napi_create_string_utf8(env,"sync-persistence-index-injection",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,18,f);
  napi_create_string_utf8(env,"async-persistence-index-injection",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,19,f);
  napi_create_string_utf8(env,"shared-index-ownership",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,20,f);
  napi_create_string_utf8(env,"single-writer-admission",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,21,f);
  napi_create_string_utf8(env,"scan-runtime-ownership",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,22,f);
  napi_create_string_utf8(env,"async-work-registry",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,23,f);
  napi_create_string_utf8(env,"cooperative-persistence-cancellation",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,24,f);
  napi_create_string_utf8(env,"adaptive-scan-workers",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,25,f);
  napi_create_string_utf8(env,"scan-signature-prefilter",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,26,f);
  napi_create_string_utf8(env,"scan-fallback-policy-v1",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,27,f);
  napi_create_string_utf8(env,"scan-thumbnail-input-reuse",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,28,f);
  napi_create_string_utf8(env,"adaptive-thumbnail-fill",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,29,f);
  napi_create_string_utf8(env,"exact-bulk-delete",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,30,f);
  napi_create_string_utf8(env,"async-exact-bulk-delete",NAPI_AUTO_LENGTH,&f);napi_set_element(env,feats,31,f);
  napi_set_named_property(env,r,"features",feats);
  set_int64(env,r,"maxImageDimension",(int64_t)image_decode_limits::kMaxDimension);
  set_int64(env,r,"maxSourcePixels",(int64_t)image_decode_limits::kMaxSourcePixels);
  set_int64(env,r,"maxDecodedBytes",(int64_t)image_decode_limits::kMaxDecodedBytes);
  set_int64(env,r,"scanSignatureBytes",(int64_t)SCAN_IMAGE_SIGNATURE_BYTES);
  set_int64(env,r,"scanWorkerCount",workerPolicy.workerCount);set_int64(env,r,"scanQueueCapacity",(int64_t)workerPolicy.queueCapacity);
  set_int64(env,r,"scanLogicalProcessors",workerPolicy.logicalProcessors);
  set_int64(env,r,"scanTotalMemoryBytes",(int64_t)workerPolicy.totalMemoryBytes);
  set_int64(env,r,"scanAvailableMemoryBytes",(int64_t)workerPolicy.availableMemoryBytes);
  set_bool(env,r,"scanWorkerOverride",workerPolicy.overridden);
  set_int64(env,r,"scanWorkerMin",kMinScanWorkerCount);set_int64(env,r,"scanWorkerMax",kMaxScanWorkerCount);
  set_string(env,r,"scanWorkerPolicy","cpu-memory-bounded-v1");
  set_int64(env,r,"thumbnailScanWorkerCount",thumbnailWorkerPolicy.scanWorkerCount);
  set_int64(env,r,"thumbnailFillWorkerCount",thumbnailWorkerPolicy.fillWorkerCount);
  set_int64(env,r,"thumbnailQueueCapacity",(int64_t)thumbnailWorkerPolicy.queueCapacity);
  set_bool(env,r,"thumbnailWorkerOverride",thumbnailWorkerPolicy.overridden);
  set_string(env,r,"thumbnailWorkerPolicy","index-priority-adaptive-fill-v1");
  set_string(env,r,"scanRuntimeMode","env-owned-shared-lifetime");
  set_string(env,r,"stopScanAsyncMode","shared-runtime-owned");
  set_bool(env,r,"scanStopInProgress",scan.stopInProgress.load());
  set_int64(env,r,"scanStopWorkCount",scan.stopWorkCount.load());
  set_bool(env,r,"scanStopJoinActive",scan.stopJoinActive.load());
  set_int32(env,r,"scanSnapshotTestPhase",scan.snapshotTestPhase.load());
  set_string(env,r,"asyncWorkMode","env-owned-explicit-cancel-teardown-drain");
  set_string(env,r,"asyncWorkCancellationMode","explicit-cooperative-persistence-native-queued");
  set_int64(env,r,"asyncWorkActiveCount",(int64_t)asyncStatus.active);
  set_int64(env,r,"asyncWorkRunningCount",(int64_t)asyncStatus.running);
  set_int64(env,r,"asyncWorkCancellableCount",(int64_t)asyncStatus.cancellable);
  set_int64(env,r,"asyncWorkPreCommitCount",(int64_t)asyncStatus.preCommit);
  set_bool(env,r,"asyncWorkClosing",asyncStatus.closing);
  set_int64(env,r,"asyncWorkCancelAccepted",context.asyncWorks->cancelAccepted());
  set_string(env,r,"scanMetricsMode","runtime-owned");
  set_string(env,r,"indexRuntimeMode","process-shared-owned");
  set_string(env,r,"addonContextMode","env-owned-scan-shared-index-owner");
  set_string(env,r,"scanIndexMode","context-injected-shared");
  set_string(env,r,"searchIndexMode","context-injected-shared");
  set_string(env,r,"persistenceIndexMode","context-injected-shared");
  set_string(env,r,"indexWriteMode","single-writer-process-shared");
  auto writerStatus=get_addon_context(env).index->writerStatus();
  set_bool(env,r,"indexWriterActive",writerStatus.first);
  set_string(env,r,"indexWriterOperation",writerStatus.second.c_str());
  return r;
}

static napi_value CancelAsyncWork(napi_env env,napi_callback_info){
  auto cancelled=get_addon_context(env).asyncWorks->requestCancellation();
  napi_value result;napi_create_object(env,&result);set_bool(env,result,"ok",true);
  set_int64(env,result,"cooperativeRequested",(int64_t)cancelled.first);
  set_int64(env,result,"nativeCancelAccepted",(int64_t)cancelled.second);
  return result;
}

static napi_value StartNativeThumbnailRebuild(napi_env env,napi_callback_info info){
  try{
    size_t argc=5;napi_value argv[5];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
    if(argc<4)return native_error(env,"startNativeThumbnailRebuild requires roots, cacheDir, version, workers");
    const std::vector<std::string> roots=split_scan_roots(get_string(env,argv[0]));
    const std::string cacheDir=get_string(env,argv[1]);
    const int version=get_int32(env,argv[2]);
    const int workers=get_int32(env,argv[3]);
    bool requestCuda=false;if(argc>=5)napi_get_value_bool(env,argv[4],&requestCuda);
    std::string error;const bool ok=thumbnail_rebuilder::start(roots,cacheDir,version,workers,requestCuda,error);
    napi_value r;napi_create_object(env,&r);set_bool(env,r,"ok",ok);
    if(!error.empty())set_string(env,r,"error",error.c_str());
    return r;
  }catch(const std::exception& e){return native_error(env,e.what());}
  catch(...){return native_error(env,"startNativeThumbnailRebuild error");}
}

static napi_value GetNativeThumbnailRebuildProgress(napi_env env,napi_callback_info){
  const auto progress=thumbnail_rebuilder::progress();
  napi_value r;napi_create_object(env,&r);
  set_string(env,r,"state",progress.state.c_str());set_int64(env,r,"total",progress.total);
  set_int64(env,r,"completed",progress.completed);set_int64(env,r,"failed",progress.failed);
  set_int64(env,r,"skipped",progress.skipped);set_int64(env,r,"pending",progress.pending);
  set_int64(env,r,"workers",progress.workers);set_int64(env,r,"startedAt",progress.startedAt);
  set_int64(env,r,"finishedAt",progress.finishedAt);set_bool(env,r,"cudaRequested",progress.cudaRequested);
  set_bool(env,r,"cudaAvailable",progress.cudaAvailable);
  set_string(env,r,"effectiveBackend",progress.effectiveBackend.c_str());
  if(!progress.cudaError.empty())set_string(env,r,"cudaError",progress.cudaError.c_str());
  if(!progress.currentPath.empty())set_string(env,r,"currentPath",progress.currentPath.c_str());
  if(!progress.error.empty())set_string(env,r,"error",progress.error.c_str());
  return r;
}

static napi_value StopNativeThumbnailRebuild(napi_env env,napi_callback_info){
  thumbnail_rebuilder::request_stop();napi_value r;napi_create_object(env,&r);set_bool(env,r,"ok",true);return r;
}

static napi_value ConfigureScanThumbnails(napi_env env,napi_callback_info info){
  try{
    size_t argc=3;napi_value argv[3];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
    if(argc<2)return native_error(env,"configureScanThumbnails requires cacheDir and enabled");
    std::string cacheDir=get_string(env,argv[0]);bool enabled=false;napi_get_value_bool(env,argv[1],&enabled);
    int version=argc>=3?get_int32(env,argv[2]):5;
    thumbnail_sidecar::configure(cacheDir,enabled,version);
    napi_value r;napi_create_object(env,&r);set_bool(env,r,"ok",true);set_bool(env,r,"enabled",enabled&&!cacheDir.empty());return r;
  }catch(const std::exception& e){return native_error(env,e.what());}
  catch(...){return native_error(env,"configureScanThumbnails error");}
}

static napi_value HashImage(napi_env env,napi_callback_info info){
  try{size_t argc=1;napi_value argv[1];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
  if(argc<1)return native_error(env,"hashImage requires filePath");
  std::string fp=get_string(env,argv[0]);napi_value r;napi_create_object(env,&r);
  auto t0=std::chrono::high_resolution_clock::now();std::vector<uint8_t> fb;if(!read_file_bytes(fp,fb)){set_bool(env,r,"ok",false);set_string(env,r,"error","Cannot read");return r;}
  int64_t fsz=(int64_t)fb.size();
  if((size_t)fsz>MAX_QUERY_IMAGE_BYTES){set_bool(env,r,"ok",false);set_string(env,r,"error","Image file too large");return r;}
  auto tr=std::chrono::high_resolution_clock::now();GrayImage gi;DecodeKind dk=DecodeKind::UNSUPPORTED;
  if(!decode_to_gray_v2(fb.data(),fb.size(),fp,gi,dk)){set_bool(env,r,"ok",false);set_string(env,r,"error",dk==DecodeKind::UNSUPPORTED?"Unsupported image format":decode_failure_reason());return r;}
  auto td=std::chrono::high_resolution_clock::now();
  uint64_t diffHash64=compute_diffhash64(gi.gray.data(),gi.width,gi.height);
  uint64_t dctHash64=compute_dcthash64(gi.gray.data(),gi.width,gi.height);
  uint64_t diffHash256[4];compute_diffhash256(gi.gray.data(),gi.width,gi.height,diffHash256);
  auto th=std::chrono::high_resolution_clock::now();set_bool(env,r,"ok",true);
  set_string(env,r,"diffHash64",hex64(diffHash64).c_str());set_string(env,r,"dctHash64",hex64(dctHash64).c_str());
  set_string(env,r,"diffHash256",hex256(diffHash256).c_str());
  set_int32(env,r,"width",gi.sourceWidth);set_int32(env,r,"height",gi.sourceHeight);set_int32(env,r,"channels",gi.channels);set_double(env,r,"fileSize",(double)fsz);
  set_double(env,r,"readMs",std::chrono::duration<double,std::milli>(tr-t0).count());
  set_double(env,r,"decodeMs",std::chrono::duration<double,std::milli>(td-tr).count());
  set_double(env,r,"hashMs",std::chrono::duration<double,std::milli>(th-td).count());
  set_string(env,r,"decodeBackend",decode_kind_name(dk));return r;
  }catch(const std::exception& e){return native_error(env,e.what());}catch(...){return native_error(env,"hashImage error");}
}

static napi_value ScanDirectory(napi_env env,napi_callback_info info){
  try{size_t argc=2;napi_value argv[2];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
  if(argc<1)return native_error(env,"scanDirectory requires rootPath");
  auto& context=get_addon_context(env);auto& runtime=*context.scan;auto& index=*context.index;
  std::string p=get_string(env,argv[0]);
  std::string sm=argc>=2?get_string(env,argv[1]):"full";
  napi_value r;napi_create_object(env,&r);
  if(runtime.stopInProgress.load()){set_bool(env,r,"ok",false);set_string(env,r,"error","Scan is stopping");return r;}
  std::lock_guard<std::mutex> lifecycleLock(runtime.lifecycleMutex);
  if(runtime.stopInProgress.load()){set_bool(env,r,"ok",false);set_string(env,r,"error","Scan is stopping");return r;}
  if(runtime.running.load()){set_bool(env,r,"ok",false);set_string(env,r,"error","Already scanning");return r;}
  if(runtime.commitFeedGeneration.load()>=9007199254740991ULL){set_bool(env,r,"ok",false);set_string(env,r,"error","Scan generation limit reached; restart the scanner");return r;}
  std::string busyOperation;auto writeLease=try_acquire_index_writer(context.index,"scan",busyOperation);
  if(!writeLease){set_bool(env,r,"ok",false);auto error=index_writer_busy_error(busyOperation);set_string(env,r,"error",error.c_str());return r;}
  bool incremental=(sm=="addNew"||sm=="update"||sm=="updateAll");
  // Non-incremental scans keep mmap'd segments: unmapping them would drop the persisted
  // segment references and a later manifest save would lose the entire segmented index.
  {std::unique_lock<std::shared_mutex> lk(index.mutex);
    if(incremental){index.records.clear();index.dedupSet.clear();}
    index.indexedCount.store(0);index.failedCount.store(0);index.totalBytes.store(0);
    runtime.metrics.reset();
    runtime.queuePending.store(0);runtime.activeWorkers.store(0);runtime.peakWorkers.store(0);
    index.resetUsnScanStatus();
    }
  reset_scan_commit_feed(runtime);
  {std::lock_guard<std::mutex> lock(runtime.exportOwnershipMutex);
    runtime.scanWriterGeneration=runtime.commitFeedGeneration.load();runtime.scanWriterToken=writeLease->token;
    runtime.scanWriterLease=writeLease;runtime.scanExports.clear();}
  {std::lock_guard<std::mutex> lk(runtime.progressMutex);runtime.currentPath.clear();runtime.error.clear();}
  // Safe thread lifecycle: join old thread and publish the replacement atomically.
  if(runtime.thread.joinable())runtime.thread.join();
  runtime.stop.store(false);runtime.paused.store(false);runtime.running.store(true);
  {std::lock_guard<std::mutex> lk(runtime.progressMutex);runtime.state="scanning";}
  try{runtime.thread=std::thread(scan_worker,std::ref(runtime),std::ref(index),p,sm,writeLease);}
  catch(...){runtime.running.store(false);{std::lock_guard<std::mutex> lk(runtime.progressMutex);runtime.state="error";runtime.error="Failed to start scan thread";}throw;}
   set_bool(env,r,"ok",true);set_int64(env,r,"generation",(int64_t)runtime.commitFeedGeneration.load());return r;
  }catch(const std::exception& e){return native_error(env,e.what());}catch(...){return native_error(env,"scan error");}
}

static napi_value ConfigureScanCommitFeed(napi_env env,napi_callback_info info){
  try{size_t argc=2;napi_value argv[2];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
    if(argc<1)return native_error(env,"configureScanCommitFeed requires enabled");
    auto& runtime=*get_addon_context(env).scan;bool enabled=false;napi_get_value_bool(env,argv[0],&enabled);
    size_t maxEntries=4096;
    if(argc>=2)maxEntries=(size_t)std::max(0,get_int32(env,argv[1]));
    maxEntries=std::clamp(maxEntries,kMinScanCommitFeedEntries,kMaxScanCommitFeedEntries);
    {std::lock_guard<std::mutex> lock(runtime.commitMutex);
      runtime.committedPaths.clear();runtime.commitFeedPendingBytes=0;runtime.commitFeedDropped=0;
      runtime.commitFeedMaxEntries=maxEntries;runtime.commitFeedEnabled.store(enabled);}
    napi_value result;napi_create_object(env,&result);set_bool(env,result,"ok",true);
    set_bool(env,result,"enabled",enabled);set_int64(env,result,"maxEntries",(int64_t)maxEntries);return result;
  }catch(const std::exception& e){return native_error(env,e.what());}catch(...){return native_error(env,"configure scan commit feed error");}
}

static napi_value DrainScanCommittedPaths(napi_env env,napi_callback_info info){
  try{size_t argc=1;napi_value argv[1];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
    auto& runtime=*get_addon_context(env).scan;size_t limit=argc>=1?(size_t)std::max(0,get_int32(env,argv[0])):kMaxScanCommitDrainEntries;
    limit=std::clamp(limit,(size_t)1,kMaxScanCommitDrainEntries);
    std::vector<std::string> paths;uint64_t generation=0,dropped=0;size_t pending=0;bool enabled=false;
    {std::lock_guard<std::mutex> lock(runtime.commitMutex);paths.reserve(std::min(limit,runtime.committedPaths.size()));
      while(paths.size()<limit&&!runtime.committedPaths.empty()){
        runtime.commitFeedPendingBytes-=runtime.committedPaths.front().size();
        paths.push_back(std::move(runtime.committedPaths.front()));runtime.committedPaths.pop_front();
      }
      generation=runtime.commitFeedGeneration.load();dropped=runtime.commitFeedDropped;
      pending=runtime.committedPaths.size();enabled=runtime.commitFeedEnabled.load();}
    napi_value result,items;napi_create_object(env,&result);napi_create_array_with_length(env,paths.size(),&items);
    for(size_t i=0;i<paths.size();i++){napi_value item;napi_create_string_utf8(env,paths[i].c_str(),paths[i].size(),&item);napi_set_element(env,items,(uint32_t)i,item);}
    set_bool(env,result,"ok",true);napi_set_named_property(env,result,"paths",items);
    set_int64(env,result,"generation",(int64_t)generation);set_int64(env,result,"pending",(int64_t)pending);
    set_int64(env,result,"dropped",(int64_t)dropped);set_bool(env,result,"enabled",enabled);return result;
  }catch(const std::exception& e){return native_error(env,e.what());}catch(...){return native_error(env,"drain scan commit feed error");}
}

static napi_value GetScanProgress(napi_env env,napi_callback_info){
  auto& context=get_addon_context(env);auto& runtime=*context.scan;auto& index=*context.index;
  napi_value r;napi_create_object(env,&r);bool running=runtime.running.load();
  std::string state,cp,err,lw,decodeBackend;int64_t ix=0,fl=0,sk=0,wn=0,tb=0;
  {std::lock_guard<std::mutex> lk(runtime.progressMutex);state=runtime.stopInProgress.load()?"stopping":(running?(runtime.paused.load()?"paused":"scanning"):runtime.state);cp=runtime.currentPath;err=(state=="error")?runtime.error:"";lw=runtime.lastWarning;decodeBackend=runtime.decodeBackend;}
  ix=index.indexedCount.load();fl=index.failedCount.load();sk=runtime.metrics.skipped.load();wn=runtime.metrics.warnings.load();tb=index.totalBytes.load();
  int64_t nc=runtime.metrics.newFiles.load(),si=runtime.metrics.skippedIndexed.load(),su=runtime.metrics.skippedUnchanged.load(),uc=runtime.metrics.updated.load();
  auto dur=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-runtime.startTime).count();
  set_string(env,r,"state",state.c_str());set_int64(env,r,"indexedCount",ix);set_int64(env,r,"failedCount",fl);
  set_int64(env,r,"generation",(int64_t)runtime.commitFeedGeneration.load());
  set_bool(env,r,"cancelled",runtime.commitFeedGeneration.load()!=0&&runtime.cancelledGeneration.load()==runtime.commitFeedGeneration.load());
  set_int64(env,r,"skippedCount",sk);set_int64(env,r,"warningCount",wn);set_int64(env,r,"totalBytes",tb);
  set_int64(env,r,"signatureRejectedCount",runtime.metrics.signatureRejected.load());
  set_int64(env,r,"newCount",nc);set_int64(env,r,"skippedIndexed",si);set_int64(env,r,"skippedUnchanged",su);set_int64(env,r,"updatedCount",uc);
  set_string(env,r,"currentPath",cp.c_str());
  if(!err.empty())set_string(env,r,"lastError",err.c_str());
  if(!lw.empty())set_string(env,r,"lastWarning",lw.c_str());
  set_int64(env,r,"durationMs",dur);
  set_bool(env,r,"detailedMetricsEnabled",runtime.detailedMetrics.load());
  // Perf timing (milliseconds)
  set_int64(env,r,"enumMs",runtime.metrics.enumUs.load()/1000);set_int64(env,r,"filesystemEnumMs",runtime.metrics.filesystemEnumUs.load()/1000);
  set_int64(env,r,"queueWaitMs",runtime.metrics.queueWaitUs.load()/1000);set_int64(env,r,"readMs",runtime.metrics.readUs.load()/1000);
  set_int64(env,r,"queueSubmitCount",runtime.metrics.queueSubmitCount.load());set_int64(env,r,"queueBlockedCount",runtime.metrics.queueBlockedCount.load());
  set_int64(env,r,"readFileCount",runtime.metrics.readFileCount.load());set_int64(env,r,"readBytes",runtime.metrics.readBytes.load());
  set_int64(env,r,"normalizeMs",runtime.metrics.normalizeUs.load()/1000);
  set_int64(env,r,"mapLookupMs",runtime.metrics.mapLookupUs.load()/1000);set_int64(env,r,"statMs",runtime.metrics.statUs.load()/1000);
  set_int64(env,r,"decodeMsTotal",runtime.metrics.decodeUs.load()/1000);set_int64(env,r,"hashMsTotal",runtime.metrics.hashUs.load()/1000);
  set_string(env,r,"decodeBackend",decodeBackend.c_str());
  set_int64(env,r,"pushMs",runtime.metrics.pushUs.load()/1000);set_int64(env,r,"commitMs",runtime.metrics.commitUs.load()/1000);set_int64(env,r,"totalScanMs",runtime.metrics.totalUs.load()/1000);
  // USN metrics
  auto scanStatus=index.scanStatus();
  set_string(env,r,"backend",scanStatus.backend.c_str());
  set_string(env,r,"fallbackReason",scanStatus.fallbackReason.c_str());
  set_string(env,r,"fallbackCode",scanStatus.fallbackCode.c_str());
  set_string(env,r,"fallbackAction",scanStatus.fallbackAction.c_str());
  set_int64(env,r,"usnWin32Error",scanStatus.win32Error);
  set_int64(env,r,"usnRecordsRead",index.usnRecordsRead);
  set_int64(env,r,"usnChangedFiles",index.usnChangedFiles);
  set_int64(env,r,"usnDeletedFiles",index.usnDeletedFiles);
  set_int64(env,r,"usnRenamedFiles",index.usnRenamedFiles);
  set_int64(env,r,"usnReadMs",index.usnReadMs);
  set_int64(env,r,"enumDirCount",runtime.metrics.enumDirs.load());set_int64(env,r,"enumFileCount",runtime.metrics.enumFiles.load());
  set_int64(env,r,"enumImageCount",runtime.metrics.enumImages.load());set_int64(env,r,"enumSkippedDirCount",runtime.metrics.enumSkippedDirs.load());
  set_int64(env,r,"scanWorkerCount",runtime.workerCount.load());set_int64(env,r,"scanQueueCapacity",runtime.queueCapacity.load());
  set_int64(env,r,"scanLogicalProcessors",runtime.logicalProcessors.load());
  set_int64(env,r,"scanTotalMemoryBytes",runtime.totalMemoryBytes.load());
  set_int64(env,r,"scanAvailableMemoryBytes",runtime.availableMemoryBytes.load());
  set_bool(env,r,"scanWorkerOverride",runtime.workerOverride.load());
  set_string(env,r,"scanWorkerPolicy","cpu-memory-bounded-v1");
  set_int64(env,r,"scanQueuePending",runtime.queuePending.load());set_int64(env,r,"scanPeakQueuePending",runtime.peakQueuePending.load());set_int64(env,r,"scanActiveWorkers",runtime.activeWorkers.load());
  set_int64(env,r,"scanPeakWorkers",runtime.peakWorkers.load());set_int64(env,r,"scanWorkerMinCompleted",runtime.workerMinCompleted.load());set_int64(env,r,"scanWorkerMaxCompleted",runtime.workerMaxCompleted.load());
  set_int64(env,r,"scanWorkerMinBusyMs",runtime.workerMinBusyUs.load()/1000);set_int64(env,r,"scanWorkerMaxBusyMs",runtime.workerMaxBusyUs.load()/1000);
  auto thumb=thumbnail_sidecar::stats();
  set_bool(env,r,"thumbnailEnabled",thumb.enabled);
  set_int64(env,r,"thumbnailQueued",thumb.queued);set_int64(env,r,"thumbnailCompleted",thumb.completed);
  set_int64(env,r,"thumbnailFailed",thumb.failed);set_int64(env,r,"thumbnailDropped",thumb.dropped);
  set_int64(env,r,"thumbnailPending",thumb.pending);
  set_int64(env,r,"thumbnailInputReused",thumb.inputReused);
  set_int64(env,r,"thumbnailInputReusedBytes",thumb.inputReusedBytes);
  set_int64(env,r,"thumbnailInputFallback",thumb.inputFallback);
  set_int64(env,r,"thumbnailSourceReads",thumb.sourceReads);
  set_int64(env,r,"thumbnailRetainedInputBytes",thumb.retainedInputBytes);
  set_int64(env,r,"thumbnailRetainedInputLimitBytes",thumb.retainedInputLimitBytes);
  set_int64(env,r,"thumbnailWorkerCount",thumb.workerCount);
  set_int64(env,r,"thumbnailScanWorkerCount",thumb.scanWorkerCount);
  set_int64(env,r,"thumbnailFillWorkerCount",thumb.fillWorkerCount);
  set_int64(env,r,"thumbnailQueueCapacity",thumb.queueCapacity);
  set_int64(env,r,"thumbnailDeferred",thumb.deferred);
  set_int64(env,r,"thumbnailDeferredPending",thumb.deferredPending);
  set_int64(env,r,"thumbnailDeferredPathBytes",thumb.deferredPathBytes);
  set_int64(env,r,"thumbnailDeferredEntryLimit",thumb.deferredEntryLimit);
  set_int64(env,r,"thumbnailDeferredPathLimitBytes",thumb.deferredPathLimitBytes);
  set_int64(env,r,"thumbnailFillCompleted",thumb.fillCompleted);
  set_int64(env,r,"thumbnailFillFailed",thumb.fillFailed);
  set_int64(env,r,"thumbnailCancelled",thumb.cancelled);
  set_int64(env,r,"thumbnailLogicalProcessors",thumb.logicalProcessors);
  set_int64(env,r,"thumbnailTotalMemoryBytes",thumb.totalMemoryBytes);
  set_int64(env,r,"thumbnailAvailableMemoryBytes",thumb.availableMemoryBytes);
  set_bool(env,r,"thumbnailWorkerOverride",thumb.workerOverride);
  set_string(env,r,"thumbnailWorkerPolicy","index-priority-adaptive-fill-v1");
  set_string(env,r,"thumbnailPhase",thumb.phase.c_str());
  // USN state info
  {std::lock_guard<std::mutex> lk(index.usnMutex);
   set_bool(env,r,"usnStateLoaded",!index.usnStates.empty());
   int64_t lastUsn=-1;uint64_t jid=0;
   for(auto& s:index.usnStates){lastUsn=s.lastUsn;jid=s.journalId;break;}
   set_int64(env,r,"usnLastUsn",lastUsn);
   set_int64(env,r,"usnJournalId",(int64_t)jid);}
  // Detect if USN requires admin
  {set_bool(env,r,"usnRequiresAdmin",scanStatus.fallbackCode=="volume-access-denied");}
  return r;
}

struct StopScanAsyncData{
  napi_async_work work=nullptr;
  napi_deferred deferred=nullptr;
  std::shared_ptr<AsyncWorkRegistry> registry;
  std::shared_ptr<ScanRuntime> runtime;
  bool ok=false;
  bool generationBound=false;
  std::vector<std::pair<napi_deferred,bool>> waiters;
  std::string error;
};

static void StopScanAsyncExecute(napi_env,void* data){
  auto* d=static_cast<StopScanAsyncData*>(data);
  struct Joining{ScanRuntime& runtime;Joining(ScanRuntime& r):runtime(r){runtime.stopJoinActive.store(true);}~Joining(){runtime.stopJoinActive.store(false);}}joining(*d->runtime);
  try{
    stop_scan_sync(*d->runtime);
    d->ok=true;
  }catch(const std::exception& e){d->error=e.what();}
  catch(...){d->error="Unknown stop scan error";}
}

static void StopScanAsyncComplete(napi_env env,napi_status status,void* data){
  auto* d=static_cast<StopScanAsyncData*>(data);
  const bool ok=status==napi_ok&&d->ok;
  auto resolve=[&](napi_deferred deferred,bool generationBound){
    napi_value result;napi_create_object(env,&result);set_bool(env,result,"ok",ok);
    if(generationBound)set_bool(env,result,"matched",true);
    if(!ok)set_string(env,result,"error",d->error.empty()?"Failed to stop scan":d->error.c_str());
    napi_resolve_deferred(env,deferred,result);
  };
  resolve(d->deferred,d->generationBound);
  for(auto& waiter:d->waiters)resolve(waiter.first,waiter.second);
  get_addon_context(env).activeStop=nullptr;
  finish_registered_async_work(env,d->registry,d->work);
  if(d->runtime->stopWorkCount.fetch_sub(1)==1)d->runtime->stopInProgress.store(false);
  delete d;
}

static napi_value queue_stop_scan_async(napi_env env,bool generationBound=false,uint64_t expectedGeneration=0){
  auto& context=get_addon_context(env);
  if(context.activeStop){
    napi_deferred deferred;napi_value promise;napi_create_promise(env,&deferred,&promise);
    // Starts are blocked by stopInProgress until this pending join completes.
    // Do not acquire the lifecycle mutex held by the worker while it joins.
    if(generationBound&&context.scan->commitFeedGeneration.load()!=expectedGeneration){
      napi_value result;napi_create_object(env,&result);set_bool(env,result,"ok",true);set_bool(env,result,"matched",false);
      napi_resolve_deferred(env,deferred,result);
    }else context.activeStop->waiters.emplace_back(deferred,generationBound);
    return promise;
  }
  auto* d=new StopScanAsyncData();
  d->runtime=context.scan;d->registry=context.asyncWorks;
  d->generationBound=generationBound;
  napi_value promise;napi_create_promise(env,&d->deferred,&promise);
  // Scan start/reset and conditional stop share the same lifecycle lock. Keep
  // the generation check and stopInProgress latch indivisible so stale cleanup
  // cannot stop a replacement scan or release its writer lease.
  std::unique_lock<std::mutex> lifecycleLock(d->runtime->lifecycleMutex);
  if(generationBound&&d->runtime->commitFeedGeneration.load()!=expectedGeneration){
    napi_value result;napi_create_object(env,&result);set_bool(env,result,"ok",true);set_bool(env,result,"matched",false);
    napi_resolve_deferred(env,d->deferred,result);delete d;return promise;
  }
  napi_status status=create_registered_async_work(env,d->registry,"fast_scanner:stopScanAsync",
                                                  StopScanAsyncExecute,StopScanAsyncComplete,d,&d->work);
  if(status!=napi_ok){
    napi_value result;napi_create_object(env,&result);set_bool(env,result,"ok",false);
    set_string(env,result,"error","Failed to create async stop work");
    napi_resolve_deferred(env,d->deferred,result);delete d;return promise;
  }
  d->runtime->stopWorkCount.fetch_add(1);d->runtime->stopInProgress.store(true);
  request_scan_stop(*d->runtime);
  lifecycleLock.unlock();
  context.activeStop=d;
  status=queue_registered_async_work(env,d->registry,&d->work);
  if(status!=napi_ok){
    context.activeStop=nullptr;
    if(d->runtime->stopWorkCount.fetch_sub(1)==1)d->runtime->stopInProgress.store(false);
    napi_value result;napi_create_object(env,&result);set_bool(env,result,"ok",false);
    set_string(env,result,"error","Failed to queue async stop work");
    napi_resolve_deferred(env,d->deferred,result);delete d;
  }
  return promise;
}

static napi_value StopScanAsync(napi_env env,napi_callback_info){return queue_stop_scan_async(env);}

static napi_value StopScanGenerationAsync(napi_env env,napi_callback_info info){
  size_t argc=1;napi_value argv[1];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
  double generation=0;
  if(argc!=1||napi_get_value_double(env,argv[0],&generation)!=napi_ok||
      !std::isfinite(generation)||generation<1||generation>9007199254740991.0||std::floor(generation)!=generation){
    return reject_missing_args(env,"A positive safe-integer scan generation is required");
  }
  return queue_stop_scan_async(env,true,(uint64_t)generation);
}

static napi_value StopScan(napi_env env,napi_callback_info){
  stop_scan_sync(*get_addon_context(env).scan);
  napi_value r;napi_create_object(env,&r);set_bool(env,r,"ok",true);return r;
}
static napi_value PauseScan(napi_env env,napi_callback_info){
  auto& runtime=*get_addon_context(env).scan;
  if(!runtime.running.load()||runtime.stopInProgress.load())return native_error(env,"No active scan to pause");
  runtime.paused.store(true);
  if(!runtime.running.load()||runtime.stopInProgress.load()){runtime.paused.store(false);return native_error(env,"No active scan to pause");}
  napi_value r;napi_create_object(env,&r);set_bool(env,r,"ok",true);return r;
}
static napi_value ResumeScan(napi_env env,napi_callback_info){
  auto& runtime=*get_addon_context(env).scan;
  if(!runtime.running.load()||runtime.stopInProgress.load())return native_error(env,"No active scan to resume");
  runtime.paused.store(false);runtime.pauseCondition.notify_all();napi_value r;napi_create_object(env,&r);set_bool(env,r,"ok",true);return r;
}
static napi_value IsScanPaused(napi_env env,napi_callback_info){
  napi_value r;napi_create_object(env,&r);set_bool(env,r,"paused",get_addon_context(env).scan->paused.load());return r;
}
static napi_value GetIndexStats(napi_env env,napi_callback_info){
  auto& index=*get_addon_context(env).index;
  napi_value r;napi_create_object(env,&r);int64_t fl=0,tb=0;int64_t c=0;std::string lp;
  {std::shared_lock<std::shared_mutex> lk(index.mutex);
    if(index.mode=="segment_mmap"){for(auto& seg:index.segments)c+=seg->recordCount;}
    else{c=(int64_t)index.records.size();}
    fl=index.failedCount;tb=index.totalBytes;if(!index.records.empty())lp=index.records.back().path;}
  set_int64(env,r,"indexedCount",c);set_int64(env,r,"failedCount",fl);set_int64(env,r,"totalBytes",tb);set_string(env,r,"lastIndexedPath",lp.c_str());return r;
}
static napi_value ClearIndex(napi_env env,napi_callback_info){
  auto& context=get_addon_context(env);auto& runtime=*context.scan;auto& index=*context.index;
  std::lock_guard<std::mutex> lifecycleLock(runtime.lifecycleMutex);
  if(runtime.running.load()||runtime.stopInProgress.load())return native_error(env,"Stop the active scan before clearing the index");
  std::string busyOperation;auto writeLease=try_acquire_index_writer(context.index,"clear",busyOperation);
  if(!writeLease){auto error=index_writer_busy_error(busyOperation);return native_error(env,error.c_str());}
  if(runtime.thread.joinable())runtime.thread.join();finish_scan_stop(runtime);
  unmap_index(index);{std::unique_lock<std::shared_mutex> lk(index.mutex);index.records.clear();index.dedupSet.clear();index.pathIndexMap.clear();index.failedPathMap.clear();index.replacedPaths.clear();index.deletedPaths.clear();index.indexedCount.store(0);index.failedCount.store(0);index.totalBytes.store(0);}
  index.resetUsnScanStatus();
  runtime.metrics.reset();
  {std::lock_guard<std::mutex> lk(runtime.progressMutex);runtime.currentPath.clear();runtime.decodeBackend.clear();}
  index.dirty.store(false);
  index.nextId.store(1);napi_value r;napi_create_object(env,&r);set_bool(env,r,"ok",true);return r;
}
static uint64_t parse_hex64(const std::string& s){uint64_t v=0;for(char c:s){v<<=4;if(c>='0'&&c<='9')v|=c-'0';else if(c>='a'&&c<='f')v|=c-'a'+10;else if(c>='A'&&c<='F')v|=c-'A'+10;}return v;}

static bool find_effective_record_locked(IndexRuntime& index,const std::string& normalizedPath,ImageRecord& out,bool& fromSegment){
  for(auto it=index.records.rbegin();it!=index.records.rend();++it){
    if(normalize_path(it->path)==normalizedPath){out=*it;fromSegment=false;return true;}
  }
  if(index.deletedPaths.count(normalizedPath)||index.replacedPaths.count(normalizedPath))return false;
  for(auto& seg:index.segments){
    if(!seg||!seg->view)continue;
    auto* meta=(const IdxMetaFwd*)seg->metadata;
    for(uint64_t i=0;i<seg->recordCount;i++){
      std::string recordPath(seg->pathBytes+seg->pathOffsets[i]);
      if(normalize_path(recordPath)!=normalizedPath)continue;
      out.id=index.nextId.fetch_add(1);out.path=recordPath;
      out.width=meta[i].width;out.height=meta[i].height;out.channels=0;
      out.fileSize=meta[i].fileSize;out.modifiedTime=meta[i].modifiedTime;
      out.diffHash64=seg->diffHash[i];out.dctHash64=seg->dctHash?seg->dctHash[i]:0;
      fromSegment=true;return true;
    }
  }
  return false;
}

static napi_value QueryIndexRecords(napi_env env,napi_callback_info info){
  try{
    auto& index=*get_addon_context(env).index;
    size_t argc=3;napi_value argv[3];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
    std::string query=argc>=1?get_string(env,argv[0]):"";
    std::transform(query.begin(),query.end(),query.begin(),[](unsigned char c){return(char)tolower(c);});
    std::replace(query.begin(),query.end(),'/','\\');
    int offset=argc>=2?std::max(0,get_int32(env,argv[1])):0;
    int limit=argc>=3?std::clamp(get_int32(env,argv[2]),1,200):50;
    std::vector<ImageRecord> matches;matches.reserve((size_t)limit+1);
    std::unordered_set<std::string> seen;
    int matched=0;int64_t scanned=0;
    {
      std::shared_lock<std::shared_mutex> lk(index.mutex);
      auto consider=[&](const ImageRecord& rec){
        std::string np=normalize_path(rec.path);scanned++;
        if(seen.count(np))return;
        seen.insert(np);
        if(!query.empty()&&np.find(query)==std::string::npos)return;
        if(matched++<offset)return;
        if((int)matches.size()<=limit)matches.push_back(rec);
      };
      for(auto it=index.records.rbegin();it!=index.records.rend()&&(int)matches.size()<=limit;++it)consider(*it);
      for(auto sit=index.segments.begin();sit!=index.segments.end()&&(int)matches.size()<=limit;++sit){
        auto& seg=*sit;if(!seg||!seg->view)continue;
        auto* meta=(const IdxMetaFwd*)seg->metadata;
        for(uint64_t i=0;i<seg->recordCount&&(int)matches.size()<=limit;i++){
          std::string recordPath(seg->pathBytes+seg->pathOffsets[i]);
          std::string np=normalize_path(recordPath);
          // Replaced paths stay visible from their newest copy: segments iterate newest-first
          // and `seen` drops the older duplicates, matching is_segment_path_hidden.
          if(index.deletedPaths.count(np)||seen.count(np)){scanned++;continue;}
          ImageRecord rec;rec.id=(int64_t)i;rec.path=recordPath;
          rec.width=meta[i].width;rec.height=meta[i].height;rec.channels=0;
          rec.fileSize=meta[i].fileSize;rec.modifiedTime=meta[i].modifiedTime;
          rec.diffHash64=seg->diffHash[i];rec.dctHash64=seg->dctHash?seg->dctHash[i]:0;
          consider(rec);
        }
      }
    }
    bool hasMore=(int)matches.size()>limit;if(hasMore)matches.resize((size_t)limit);
    napi_value result,items;napi_create_object(env,&result);napi_create_array_with_length(env,matches.size(),&items);
    for(size_t i=0;i<matches.size();i++){
      auto& rec=matches[i];napi_value item;napi_create_object(env,&item);
      set_string(env,item,"path",rec.path.c_str());set_int32(env,item,"width",rec.width);set_int32(env,item,"height",rec.height);
      set_double(env,item,"fileSize",(double)rec.fileSize);set_double(env,item,"modifiedTime",(double)rec.modifiedTime);
      std::error_code ec;bool exists=fs::is_regular_file(path_from_utf8(rec.path),ec)&&!ec;set_bool(env,item,"exists",exists);
      napi_set_element(env,items,(uint32_t)i,item);
    }
    set_bool(env,result,"ok",true);napi_set_named_property(env,result,"records",items);
    set_int32(env,result,"offset",offset);set_bool(env,result,"hasMore",hasMore);set_int64(env,result,"scanned",scanned);
    return result;
  }catch(const std::exception& e){return native_error(env,e.what());}catch(...){return native_error(env,"queryIndexRecords error");}
}

// A writer lease keeps synchronous mutations from waiting on this background
// reader. The complete effective view is captured under one shared lock.
static bool collect_index_export(IndexRuntime& index,IndexExportCursor& out,
    const std::shared_ptr<AsyncCancellationToken>& cancellation,std::string& error){
  const auto captureStart=std::chrono::steady_clock::now();
  std::shared_lock<std::shared_mutex> lk(index.mutex);
  out.lockWaitMs=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-captureStart).count();
  size_t estimated=index.records.size(),bytes=0;
  for(const auto& seg:index.segments)if(seg&&seg->view)estimated+=(size_t)seg->recordCount;
  if(estimated>INDEX_EXPORT_MAX_RECORDS){error="Index snapshot exceeds the 1000000 record safety limit";return false;}
  out.records.reserve(estimated);
  bytes=estimated*sizeof(ImageRecord);
  std::unordered_set<std::string> seen;seen.reserve(estimated);
  auto append=[&](ImageRecord rec,bool segment){
    if(((++out.scanned)&4095)==0&&async_cancellation_checkpoint(cancellation,error))return false;
    auto np=normalize_path(rec.path);
    if((segment&&index.deletedPaths.count(np))||!seen.insert(np).second)return true;
    // Include normalized keys and hash-node overhead in the temporary budget.
    bytes+=rec.path.size()+np.size()+96;
    if(bytes>INDEX_EXPORT_MAX_BYTES){error="Index snapshot exceeds the 128 MiB export safety limit";return false;}
    out.records.push_back(std::move(rec));return true;
  };
  for(auto it=index.records.rbegin();it!=index.records.rend();++it)if(!append(*it,false))return false;
  for(const auto& seg:index.segments){
    if(!seg||!seg->view)continue;
    auto* meta=(const IdxMetaFwd*)seg->metadata;
    for(uint64_t i=0;i<seg->recordCount;i++){
      ImageRecord rec{};rec.id=(int64_t)i;rec.path=std::string(seg->pathBytes+seg->pathOffsets[i]);
      rec.width=meta[i].width;rec.height=meta[i].height;rec.fileSize=meta[i].fileSize;rec.modifiedTime=meta[i].modifiedTime;
      rec.diffHash64=seg->diffHash[i];rec.dctHash64=seg->dctHash?seg->dctHash[i]:0;
      if(!append(std::move(rec),true))return false;
    }
  }
  out.captureMs=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-captureStart).count();
  return !async_cancellation_checkpoint(cancellation,error);
}

static bool collect_scan_export(IndexRuntime& index,IndexExportCursor& out,
    const std::shared_ptr<AsyncCancellationToken>& cancellation,std::string& error){
  const auto captureStart=std::chrono::steady_clock::now();
  std::shared_lock<std::shared_mutex> lock(index.mutex);
  out.lockWaitMs=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-captureStart).count();
  size_t estimated=index.records.size();
  for(const auto& segment:index.segments)if(segment&&segment->view)estimated+=(size_t)segment->recordCount;
  if(estimated>INDEX_EXPORT_MAX_RECORDS){error="Scan snapshot exceeds the 1000000 record safety limit";return false;}
  out.scanRecords.reserve(estimated);
  size_t bytes=estimated*sizeof(ScanExportRecord);
  std::unordered_set<std::string> seen;seen.reserve(estimated);
  auto append=[&](std::string path,int64_t fileSize,int64_t modifiedTime,bool segment){
    if(((++out.scanned)&255)==0&&async_cancellation_checkpoint(cancellation,error))return false;
    if(path.size()+128>INDEX_EXPORT_PAGE_BYTES){error="Scan snapshot path exceeds the page byte safety limit";return false;}
    auto normalized=normalize_path(path);
    if((segment&&index.deletedPaths.count(normalized))||!seen.insert(normalized).second)return true;
    bytes+=path.size()+normalized.size()+96;
    if(bytes>INDEX_EXPORT_MAX_BYTES){error="Scan snapshot exceeds the 128 MiB export safety limit";return false;}
    out.scanRecords.push_back({std::move(path),fileSize,modifiedTime});return true;
  };
  for(auto it=index.records.rbegin();it!=index.records.rend();++it)
    if(!append(it->path,it->fileSize,it->modifiedTime,false))return false;
  for(const auto& segment:index.segments){
    if(!segment||!segment->view)continue;
    auto* metadata=(const IdxMetaFwd*)segment->metadata;
    for(uint64_t i=0;i<segment->recordCount;i++)
      if(!append(std::string(segment->pathBytes+segment->pathOffsets[i]),metadata[i].fileSize,metadata[i].modifiedTime,true))return false;
  }
  out.captureMs=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-captureStart).count();
  return !async_cancellation_checkpoint(cancellation,error);
}

static napi_value make_index_record(napi_env env,const ImageRecord& rec,bool parity){
  napi_value item;napi_create_object(env,&item);
  set_string(env,item,"path",rec.path.c_str());set_int32(env,item,"width",rec.width);set_int32(env,item,"height",rec.height);
  set_double(env,item,"fileSize",(double)rec.fileSize);set_double(env,item,"modifiedTime",(double)rec.modifiedTime);
  if(parity){set_int32(env,item,"channels",rec.channels);set_string(env,item,"diffHash64",hex64(rec.diffHash64).c_str());set_string(env,item,"dctHash64",hex64(rec.dctHash64).c_str());}
  return item;
}

// Compatibility API for small/diagnostic callers. Production consumers use the
// asynchronous cursor below so Native scanning and JS conversion are separated.
static napi_value SnapshotIndexRecords(napi_env env,napi_callback_info){
  try{
    IndexExportCursor cursor;std::string error;
    if(!collect_index_export(*get_addon_context(env).index,cursor,{},error))return native_error(env,error.c_str());
    const auto conversionStart=std::chrono::steady_clock::now();
    napi_value result,items;napi_create_object(env,&result);napi_create_array_with_length(env,cursor.records.size(),&items);
    bool parity=windows_env_flag_enabled("REASONIX_NATIVE_PARITY_FIELDS");
    for(size_t i=0;i<cursor.records.size();i++)napi_set_element(env,items,(uint32_t)i,make_index_record(env,cursor.records[i],parity));
    set_double(env,result,"captureMs",cursor.captureMs);set_double(env,result,"lockWaitMs",cursor.lockWaitMs);
    set_double(env,result,"jsConversionMs",std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-conversionStart).count());
    set_bool(env,result,"ok",true);napi_set_named_property(env,result,"records",items);
    set_int64(env,result,"recordCount",(int64_t)cursor.records.size());set_int64(env,result,"scanned",cursor.scanned);return result;
  }catch(const std::exception& e){return native_error(env,e.what());}catch(...){return native_error(env,"snapshotIndexRecords error");}
}

static std::string reserve_index_export(AddonContext& context,const std::shared_ptr<IndexExportCursor>& cursor){
  if(context.exports.size()>=2)throw std::runtime_error("Close an existing index export before opening another (limit 2)");
  auto token=std::to_string(context.exportOwner)+":"+std::to_string(++context.nextExportId);context.exports.emplace(token,cursor);return token;
}

struct IndexExportAsyncData{
  napi_async_work work=nullptr;napi_deferred deferred=nullptr;
  std::shared_ptr<AsyncWorkRegistry> registry;
  std::shared_ptr<AsyncCancellationToken> cancellation=std::make_shared<AsyncCancellationToken>();
  std::shared_ptr<IndexRuntime> index;
  std::shared_ptr<IndexWriteLease> writeLease;
  std::shared_ptr<ScanRuntime> scan;
  std::shared_ptr<IndexExportCursor> cursor;
  std::string token,error;bool ok=false,closing=false,rejectedClose=false;
};
static void IndexExportExecute(napi_env,void* data){
  auto* d=static_cast<IndexExportAsyncData*>(data);
  struct Cleanup{IndexExportAsyncData* d;~Cleanup(){
    if(!d->ok&&d->cursor){std::vector<ImageRecord>().swap(d->cursor->records);std::vector<ScanExportRecord>().swap(d->cursor->scanRecords);}
  }}cleanup{d};
  try{
    d->cancellation->markStarted();
    if(d->closing){d->cursor.reset();d->ok=true;return;}
    if(async_cancellation_checkpoint(d->cancellation,d->error))return;
    // Explicit, bounded race-test hooks only; ordinary captures never wait.
    const DWORD testDelay=d->scan?windows_env_test_delay_ms("FLOATING_CLOCK_NATIVE_SCAN_SNAPSHOT_DELAY_MS_TEST"):0;
    if(testDelay){d->scan->snapshotTestPhase.store(1);Sleep(testDelay);}
    if(async_cancellation_checkpoint(d->cancellation,d->error))return;
    d->ok=d->cursor->scanResult?collect_scan_export(*d->index,*d->cursor,d->cancellation,d->error):
      collect_index_export(*d->index,*d->cursor,d->cancellation,d->error);
    if(testDelay){d->scan->snapshotTestPhase.store(2);Sleep(testDelay);d->scan->snapshotTestPhase.store(3);}
  }catch(const std::exception& e){d->error=e.what();}catch(...){d->error="Index export failed";}
}
static void IndexExportComplete(napi_env env,napi_status status,void* data){
  auto* d=static_cast<IndexExportAsyncData*>(data);
  if(d->ok&&!d->closing&&d->scan&&d->cancellation->isRequested()){
    // Cancellation can arrive after Execute returns but before this callback.
    try{
    auto release=std::make_unique<IndexExportAsyncData>();
    release->closing=true;release->rejectedClose=true;release->registry=d->registry;
    release->deferred=d->deferred;release->token=d->token;release->cursor=std::move(d->cursor);
    release->error="Scan snapshot cancelled before publication";
    get_addon_context(env).exports[d->token].reset();
    auto queued=windows_env_flag_enabled("FLOATING_CLOCK_NATIVE_FAIL_SCAN_DISCARD_QUEUE_TEST")?napi_generic_failure:create_registered_async_work(env,release->registry,"fast_scanner:discardScanExport",IndexExportExecute,IndexExportComplete,release.get(),&release->work,release->cancellation);
    if(queued==napi_ok)queued=queue_registered_async_work(env,release->registry,&release->work);
    if(queued==napi_ok){release.release();finish_registered_async_work(env,d->registry,d->work);delete d;return;}
    // Teardown / queue failure may prohibit new work. Release bounded memory
    // here rather than retain a hidden cursor; ordinary cancellation closes off-thread.
    d->ok=false;d->error=release->error;
    }catch(...){d->ok=false;d->error="Scan snapshot cancelled before publication";}
  }
  if(d->ok&&status==napi_ok&&!d->rejectedClose){
    napi_value result;napi_create_object(env,&result);set_bool(env,result,"ok",true);
    if(!d->closing){
      d->cursor->ready=true;
      set_string(env,result,"cursor",d->token.c_str());set_int64(env,result,"recordCount",(int64_t)(d->cursor->scanResult?d->cursor->scanRecords.size():d->cursor->records.size()));
      set_int64(env,result,"scanned",d->cursor->scanned);
      set_double(env,result,"captureMs",d->cursor->captureMs);set_double(env,result,"lockWaitMs",d->cursor->lockWaitMs);
      if(d->cursor->scanResult)set_int64(env,result,"generation",(int64_t)d->cursor->scanGeneration);
    }
    napi_resolve_deferred(env,d->deferred,result);
  }else{
    get_addon_context(env).exports.erase(d->token);
    napi_value reason;napi_create_string_utf8(env,d->error.empty()?"Index export cancelled":d->error.c_str(),NAPI_AUTO_LENGTH,&reason);
    napi_reject_deferred(env,d->deferred,reason);
  }
  if(d->closing)get_addon_context(env).exports.erase(d->token);
  finish_registered_async_work(env,d->registry,d->work);delete d;
}
static napi_value SnapshotIndexRecordsAsync(napi_env env,napi_callback_info){
  try{
    auto& context=get_addon_context(env);auto d=std::make_unique<IndexExportAsyncData>();
    d->registry=context.asyncWorks;d->index=context.index;d->cursor=std::make_shared<IndexExportCursor>();
    d->cursor->includeParityFields=windows_env_flag_enabled("REASONIX_NATIVE_PARITY_FIELDS");
    std::string busy;d->writeLease=try_acquire_index_writer(context.index,"snapshot-export",busy);
    if(!d->writeLease)return reject_index_writer_busy(env,busy);
    d->token=reserve_index_export(context,d->cursor);
    napi_value promise;napi_create_promise(env,&d->deferred,&promise);
    auto status=create_registered_async_work(env,d->registry,"fast_scanner:snapshotIndexRecordsAsync",IndexExportExecute,IndexExportComplete,d.get(),&d->work,d->cancellation);
    if(status==napi_ok)status=queue_registered_async_work(env,d->registry,&d->work);
    if(status==napi_ok)d.release();else{
      context.exports.erase(d->token);napi_value reason;napi_create_string_utf8(env,"Could not queue index export",NAPI_AUTO_LENGTH,&reason);napi_reject_deferred(env,d->deferred,reason);
    }
    return promise;
  }catch(const std::exception& e){return reject_missing_args(env,e.what());}
}
static napi_value SnapshotScanRecordsAsync(napi_env env,napi_callback_info info){
  try{
    size_t argc=1;napi_value argv[1];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
    double raw=0;
    if(argc!=1||napi_get_value_double(env,argv[0],&raw)!=napi_ok||!std::isfinite(raw)||raw<1||raw>9007199254740991.0||std::floor(raw)!=raw)
      return reject_missing_args(env,"A positive safe-integer scan generation is required");
    const auto generation=(uint64_t)raw;
    auto& context=get_addon_context(env);auto& scan=*context.scan;
    auto d=std::make_unique<IndexExportAsyncData>();
    d->registry=context.asyncWorks;d->index=context.index;d->scan=context.scan;d->cursor=std::make_shared<IndexExportCursor>();
    d->cursor->scanResult=true;d->cursor->scanGeneration=generation;
    std::string ownershipError;
    {
      std::lock_guard<std::mutex> lock(scan.exportOwnershipMutex);
      if(scan.scanWriterGeneration!=generation||scan.commitFeedGeneration.load()!=generation)
        ownershipError="Scan snapshot generation was replaced";
      else if(scan.stopInProgress.load()||scan.cancelledGeneration.load()==generation)
        ownershipError="Scan snapshot generation was cancelled";
      else{
        d->writeLease=scan.scanWriterLease.lock();
        if(!d->writeLease){
          uint64_t token=0;
          if(context.index->tryAcquireWriterAfter(scan.scanWriterToken,"scan-snapshot",token,ownershipError)){
            try{d->writeLease=std::make_shared<IndexWriteLease>(context.index,token);}
            catch(...){context.index->releaseWriter(token);throw;}
            scan.scanWriterToken=token;scan.scanWriterLease=d->writeLease;
          }
        }
        if(d->writeLease){
          scan.scanExports.erase(std::remove_if(scan.scanExports.begin(),scan.scanExports.end(),[](const auto& item){return item.expired();}),scan.scanExports.end());
          // Registration and stop/cancel checks share the short ownership lock.
          scan.scanExports.push_back(d->cancellation);
        }
      }
    }
    if(!ownershipError.empty())return reject_missing_args(env,ownershipError.c_str());
    scan.snapshotTestPhase.store(0);
    d->token=reserve_index_export(context,d->cursor);
    napi_value promise;napi_create_promise(env,&d->deferred,&promise);
    auto status=create_registered_async_work(env,d->registry,"fast_scanner:snapshotScanRecordsAsync",IndexExportExecute,IndexExportComplete,d.get(),&d->work,d->cancellation);
    if(status==napi_ok)status=queue_registered_async_work(env,d->registry,&d->work);
    if(status==napi_ok)d.release();else{
      context.exports.erase(d->token);napi_value reason;napi_create_string_utf8(env,"Could not queue scan snapshot",NAPI_AUTO_LENGTH,&reason);napi_reject_deferred(env,d->deferred,reason);
    }
    return promise;
  }catch(const std::exception& e){return reject_missing_args(env,e.what());}
}

static napi_value read_index_export_page(napi_env env,napi_callback_info info,bool scanPage){
  try{
    size_t argc=4;napi_value argv[4];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
    const size_t offsetIndex=scanPage?2:1,limitIndex=offsetIndex+1;
    if(argc<=offsetIndex)return native_error(env,"Index export cursor and offset required");
    auto& exports=get_addon_context(env).exports;auto found=exports.find(get_string(env,argv[0]));
    if(found==exports.end()||!found->second||!found->second->ready)return native_error(env,"Invalid or closed index export cursor");
    auto& cursor=*found->second;
    if(cursor.scanResult!=scanPage)return native_error(env,"Wrong index export cursor type");
    if(scanPage){
      double generation=0;
      if(napi_get_value_double(env,argv[1],&generation)!=napi_ok||generation!=(double)cursor.scanGeneration)
        return native_error(env,"Wrong scan snapshot generation");
      auto& scan=*get_addon_context(env).scan;
      if(scan.commitFeedGeneration.load()!=cursor.scanGeneration)return native_error(env,"Scan snapshot generation was replaced");
      if(scan.cancelledGeneration.load()==cursor.scanGeneration)return native_error(env,"Scan snapshot generation was cancelled");
    }
    double rawOffset=-1;if(napi_get_value_double(env,argv[offsetIndex],&rawOffset)!=napi_ok||!std::isfinite(rawOffset)||rawOffset<0||rawOffset!=std::floor(rawOffset))return native_error(env,"Invalid index export offset");
    size_t total=scanPage?cursor.scanRecords.size():(cursor.pathResult?cursor.paths.size():cursor.records.size());
    if(rawOffset>(double)total)return native_error(env,"Index export offset exceeds record count");
    size_t offset=(size_t)rawOffset,limit=INDEX_EXPORT_PAGE_RECORDS;
    if(argc>limitIndex){double rawLimit=0;if(napi_get_value_double(env,argv[limitIndex],&rawLimit)!=napi_ok||!std::isfinite(rawLimit)||rawLimit<1)return native_error(env,"Invalid index export page limit");limit=(size_t)std::min(rawLimit,(double)INDEX_EXPORT_PAGE_RECORDS);}
    size_t end=offset,bytes=0;
    while(end<total&&end-offset<limit){
      size_t next=(scanPage?cursor.scanRecords[end].path.size():(cursor.pathResult?cursor.paths[end].size():cursor.records[end].path.size()))+128;
      if(end>offset&&bytes+next>INDEX_EXPORT_PAGE_BYTES)break;bytes+=next;end++;
    }
    napi_value result,items;napi_create_object(env,&result);napi_create_array_with_length(env,end-offset,&items);
    for(size_t i=offset;i<end;i++){
      napi_value item;
      if(scanPage){const auto& record=cursor.scanRecords[i];napi_create_object(env,&item);set_string(env,item,"path",record.path.c_str());set_double(env,item,"fileSize",(double)record.fileSize);set_double(env,item,"modifiedTime",(double)record.modifiedTime);}
      else if(cursor.pathResult)napi_create_string_utf8(env,cursor.paths[i].c_str(),NAPI_AUTO_LENGTH,&item);else item=make_index_record(env,cursor.records[i],cursor.includeParityFields);
      napi_set_element(env,items,(uint32_t)(i-offset),item);
    }
    set_bool(env,result,"ok",true);set_int64(env,result,"nextOffset",(int64_t)end);set_bool(env,result,"hasMore",end<total);
    if(scanPage)set_int64(env,result,"generation",(int64_t)cursor.scanGeneration);
    napi_set_named_property(env,result,cursor.pathResult?"removedPaths":"records",items);return result;
  }catch(const std::exception& e){return native_error(env,e.what());}
}
static napi_value ReadIndexExportPage(napi_env env,napi_callback_info info){return read_index_export_page(env,info,false);}
static napi_value ReadScanExportPage(napi_env env,napi_callback_info info){return read_index_export_page(env,info,true);}
static napi_value CloseIndexExport(napi_env env,napi_callback_info info){
  try{
    size_t argc=1;napi_value argv[1];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
    if(argc<1)return reject_missing_args(env,"Index export cursor required");
    auto& context=get_addon_context(env);auto found=context.exports.find(get_string(env,argv[0]));
    if(found==context.exports.end()||!found->second||!found->second->ready)return reject_missing_args(env,"Invalid or closed index export cursor");
    auto d=std::make_unique<IndexExportAsyncData>();d->closing=true;d->registry=context.asyncWorks;d->cursor=found->second;d->token=found->first;
    // Transfer the only owning reference before the worker can run, so a fast
    // close cannot race and free the large vectors on the JavaScript thread.
    found->second.reset();
    napi_value promise;napi_create_promise(env,&d->deferred,&promise);
    auto status=create_registered_async_work(env,d->registry,"fast_scanner:closeIndexExport",IndexExportExecute,IndexExportComplete,d.get(),&d->work,d->cancellation);
    if(status==napi_ok)status=queue_registered_async_work(env,d->registry,&d->work);
    if(status==napi_ok){d.release();}else{
      found->second=d->cursor;
      napi_value reason;napi_create_string_utf8(env,"Could not queue index export close",NAPI_AUTO_LENGTH,&reason);napi_reject_deferred(env,d->deferred,reason);
    }
    return promise;
  }catch(const std::exception& e){return reject_missing_args(env,e.what());}
}

static napi_value GetIndexPathStats(napi_env env,napi_callback_info info){
  try{
    auto& index=*get_addon_context(env).index;
    size_t argc=1;napi_value argv[1];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
    std::string prefix=argc>=1?normalize_path(get_string(env,argv[0])):"";
    napi_value result;napi_create_object(env,&result);
    if(!prefix.empty()&&prefix.size()<4){set_bool(env,result,"ok",false);set_string(env,result,"error","Unsafe index prefix");return result;}
    // Same boundary rule as purgeIndexPathPrefix: exact match or prefix followed by '\\'.
    auto matches=[&](const std::string& normalized){
      return prefix.empty()||normalized==prefix||(normalized.size()>prefix.size()&&
        normalized.compare(0,prefix.size(),prefix)==0&&normalized[prefix.size()]=='\\');
    };
    uint64_t count=0;double totalBytes=0;
    {
      std::shared_lock<std::shared_mutex> lk(index.mutex);
      // Mirror QueryIndexRecords visibility: newest records win via `seen`, deleted paths hidden.
      std::unordered_set<std::string> seen;
      for(auto it=index.records.rbegin();it!=index.records.rend();++it){
        std::string np=normalize_path(it->path);
        if(!seen.insert(np).second)continue;
        if(matches(np)){count++;totalBytes+=(double)it->fileSize;}
      }
      for(const auto& seg:index.segments){
        if(!seg||!seg->view)continue;
        auto* meta=(const IdxMetaFwd*)seg->metadata;
        for(uint64_t i=0;i<seg->recordCount;i++){
          std::string np=normalize_path(std::string(seg->pathBytes+seg->pathOffsets[i]));
          if(index.deletedPaths.count(np)||!seen.insert(np).second)continue;
          if(matches(np)){count++;totalBytes+=(double)meta[i].fileSize;}
        }
      }
    }
    set_bool(env,result,"ok",true);set_string(env,result,"prefix",prefix.c_str());
    set_double(env,result,"count",(double)count);set_double(env,result,"totalBytes",totalBytes);
    return result;
  }catch(const std::exception& e){return native_error(env,e.what());}
  catch(...){return native_error(env,"getIndexPathStats error");}
}

// Normalize a bare directory name for segment matching: trim, fold '/' to '\\', lowercase.
// Returns an empty string when the name is unusable (empty, nested, or shorter than 2 chars).
static std::string normalize_segment_name(const std::string& input){
  std::string name=input;
  size_t first=name.find_first_not_of(" \t\r\n"),last=name.find_last_not_of(" \t\r\n");
  name=first==std::string::npos?"":name.substr(first,last-first+1);
  std::replace(name.begin(),name.end(),'/','\\');
  for(auto& c:name)c=(char)tolower((unsigned char)c);
  if(name.size()<2||name.find('\\')!=std::string::npos)return "";
  return name;
}

static napi_value GetIndexPathSegmentStats(napi_env env,napi_callback_info info){
  try{
    auto& index=*get_addon_context(env).index;
    size_t argc=1;napi_value argv[1];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
    std::string name=argc>=1?normalize_segment_name(get_string(env,argv[0])):"";
    napi_value result;napi_create_object(env,&result);
    if(name.empty()){set_bool(env,result,"ok",false);set_string(env,result,"error","Invalid directory name");return result;}
    const std::string needle="\\"+name+"\\";
    auto matches=[&](const std::string& normalized){return normalized.find(needle)!=std::string::npos;};
    uint64_t count=0;double totalBytes=0;
    {
      std::shared_lock<std::shared_mutex> lk(index.mutex);
      // Same visibility rules as GetIndexPathStats: newest copy wins, deleted paths hidden.
      std::unordered_set<std::string> seen;
      for(auto it=index.records.rbegin();it!=index.records.rend();++it){
        std::string np=normalize_path(it->path);
        if(!seen.insert(np).second)continue;
        if(matches(np)){count++;totalBytes+=(double)it->fileSize;}
      }
      for(const auto& seg:index.segments){
        if(!seg||!seg->view)continue;
        auto* meta=(const IdxMetaFwd*)seg->metadata;
        for(uint64_t i=0;i<seg->recordCount;i++){
          std::string np=normalize_path(std::string(seg->pathBytes+seg->pathOffsets[i]));
          if(index.deletedPaths.count(np)||!seen.insert(np).second)continue;
          if(matches(np)){count++;totalBytes+=(double)meta[i].fileSize;}
        }
      }
    }
    set_bool(env,result,"ok",true);set_string(env,result,"name",name.c_str());
    set_double(env,result,"count",(double)count);set_double(env,result,"totalBytes",totalBytes);
    return result;
  }catch(const std::exception& e){return native_error(env,e.what());}
  catch(...){return native_error(env,"getIndexPathSegmentStats error");}
}

static napi_value HasIndexPath(napi_env env,napi_callback_info info){
  try{
    auto& index=*get_addon_context(env).index;
    size_t argc=1;napi_value argv[1];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
    std::string input=argc>=1?get_string(env,argv[0]):"";
    std::string np=normalize_path(input);bool found=false;
    {
      std::shared_lock<std::shared_mutex> lk(index.mutex);
      found=!np.empty()&&!index.deletedPaths.count(np)&&index.pathIndexMap.find(make_path_key(np))!=index.pathIndexMap.end();
    }
    napi_value result;napi_get_boolean(env,found,&result);return result;
  }catch(...){napi_value result;napi_get_boolean(env,false,&result);return result;}
}

static napi_value DeleteIndexPath(napi_env env,napi_callback_info info){
  try{
    auto& context=get_addon_context(env);auto& index=*context.index;
    std::string busyOperation;auto writeLease=try_acquire_index_writer(context.index,"edit-delete",busyOperation);
    if(!writeLease){auto error=index_writer_busy_error(busyOperation);return native_error(env,error.c_str());}
    size_t argc=1;napi_value argv[1];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
    std::string input=get_string(env,argv[0]),np=normalize_path(input);napi_value result;napi_create_object(env,&result);
    std::unique_lock<std::shared_mutex> lk(index.mutex);
    ImageRecord existing;bool fromSegment=false;
    if(!find_effective_record_locked(index,np,existing,fromSegment)){set_bool(env,result,"ok",false);set_string(env,result,"error","Indexed path not found");return result;}
    index.records.erase(std::remove_if(index.records.begin(),index.records.end(),[&](const ImageRecord& rec){return normalize_path(rec.path)==np;}),index.records.end());
    index.deletedPaths.insert(np);index.replacedPaths.erase(np);index.pathIndexMap.erase(make_path_key(np));
    index.dirty.store(true);set_bool(env,result,"ok",true);set_string(env,result,"path",existing.path.c_str());return result;
  }catch(const std::exception& e){return native_error(env,e.what());}catch(...){return native_error(env,"deleteIndexPath error");}
}

struct BatchDeleteRequestedPath{std::string original;std::string normalized;};
struct BatchDeleteResult{std::vector<std::string> removedPaths;int64_t remainingCount=0;};

static bool parse_batch_delete_paths(
    napi_env env,napi_value value,const char* operation,std::vector<BatchDeleteRequestedPath>& requested,
    std::unordered_set<std::string>& requestedSet,std::string& error){
  bool isArray=false;
  if(napi_is_array(env,value,&isArray)!=napi_ok||!isArray){error=std::string(operation)+" requires a path array";return false;}
  uint32_t length=0;
  if(napi_get_array_length(env,value,&length)!=napi_ok){error=std::string(operation)+" could not read the path array";return false;}
  if(length>1000000){error=std::string(operation)+" exceeds the 1000000 path safety limit";return false;}
  requested.reserve(length);requestedSet.reserve((size_t)length*2+1);
  for(uint32_t i=0;i<length;i++){
    napi_value item;
    if(napi_get_element(env,value,i,&item)!=napi_ok){error=std::string(operation)+" could not read a path";return false;}
    napi_valuetype valueType=napi_undefined;
    if(napi_typeof(env,item,&valueType)!=napi_ok||valueType!=napi_string){error=std::string(operation)+" accepts only string paths";return false;}
    std::string original=get_string(env,item);
    if(original.empty()||original.size()>32768){error=std::string(operation)+" received an invalid path";return false;}
    std::string normalized=normalize_path(original);
    if(normalized.empty())continue;
    if(requestedSet.insert(normalized).second)requested.push_back({std::move(original),std::move(normalized)});
  }
  return true;
}

// Async entry validation copies only the JavaScript strings. Path folding and
// hash-set construction are CPU work and stay on the libuv worker so a large
// source-sync batch does not spend that time on Electron's main thread.
static bool parse_batch_delete_input_paths(
    napi_env env,napi_value value,const char* operation,std::vector<std::string>& inputPaths,std::string& error){
  bool isArray=false;
  if(napi_is_array(env,value,&isArray)!=napi_ok||!isArray){error=std::string(operation)+" requires a path array";return false;}
  uint32_t length=0;
  if(napi_get_array_length(env,value,&length)!=napi_ok){error=std::string(operation)+" could not read the path array";return false;}
  if(length>1000000){error=std::string(operation)+" exceeds the 1000000 path safety limit";return false;}
  inputPaths.reserve(length);
  size_t inputBytes=(size_t)length*sizeof(std::string);
  for(uint32_t i=0;i<length;i++){
    napi_value item;
    if(napi_get_element(env,value,i,&item)!=napi_ok){error=std::string(operation)+" could not read a path";return false;}
    napi_valuetype valueType=napi_undefined;
    if(napi_typeof(env,item,&valueType)!=napi_ok||valueType!=napi_string){error=std::string(operation)+" accepts only string paths";return false;}
    std::string original=get_string(env,item);
    if(original.empty()||original.size()>32768){error=std::string(operation)+" received an invalid path";return false;}
    inputBytes+=original.size();
    if(inputBytes>INDEX_EXPORT_MAX_BYTES){error=std::string(operation)+" exceeds the 128 MiB input safety limit";return false;}
    inputPaths.push_back(std::move(original));
  }
  return true;
}

static bool normalize_batch_delete_input_paths(
    std::vector<std::string>& inputPaths,std::vector<BatchDeleteRequestedPath>& requested,
    std::unordered_set<std::string>& requestedSet,const std::shared_ptr<AsyncCancellationToken>& cancellation,
    std::string& error){
  requested.reserve(inputPaths.size());requestedSet.reserve(inputPaths.size()*2+1);
  uint64_t processed=0;
  for(auto& original:inputPaths){
    if(((++processed)&4095)==0&&async_cancellation_checkpoint(cancellation,error))return false;
    std::string normalized=normalize_path(original);
    if(normalized.empty())continue;
    if(requestedSet.insert(normalized).second)requested.push_back({std::move(original),std::move(normalized)});
  }
  std::vector<std::string>().swap(inputPaths);
  return !async_cancellation_checkpoint(cancellation,error);
}

// Build every allocation-bearing part of the edit while the index is read-only.
// The process-wide writer lease guarantees no other Native writer can change the
// view between this shared-lock plan and the short unique-lock commit below.
static bool apply_batch_delete(
    IndexRuntime& index,const std::vector<BatchDeleteRequestedPath>& requested,
    const std::unordered_set<std::string>& requestedSet,BatchDeleteResult& result,
    const std::shared_ptr<AsyncCancellationToken>& cancellation,std::string& error,bool testHooks){
  std::unordered_set<std::string> found;
  std::vector<ImageRecord> remainingRecords;
  std::unordered_set<std::string> nextDeleted,nextReplaced;
  {
    std::shared_lock<std::shared_mutex> lk(index.mutex);
    size_t estimated=index.records.size();
    for(const auto& seg:index.segments)if(seg&&seg->view)estimated+=(size_t)seg->recordCount;
    std::unordered_set<std::string> seen;seen.reserve(estimated);
    found.reserve(requested.size()*2+1);
    uint64_t scanned=0;
    auto visitVisible=[&](const std::string& rawPath,bool segmentRecord){
      std::string normalized=normalize_path(rawPath);
      if(segmentRecord&&index.deletedPaths.count(normalized))return;
      if(!seen.insert(normalized).second)return;
      if(requestedSet.count(normalized))found.insert(std::move(normalized));else result.remainingCount++;
    };
    for(auto it=index.records.rbegin();it!=index.records.rend();++it){
      if(((++scanned)&4095)==0&&async_cancellation_checkpoint(cancellation,error))return false;
      visitVisible(it->path,false);
    }
    for(const auto& seg:index.segments){
      if(!seg||!seg->view)continue;
      for(uint64_t i=0;i<seg->recordCount;i++){
        if(((++scanned)&4095)==0&&async_cancellation_checkpoint(cancellation,error))return false;
        visitVisible(std::string(seg->pathBytes+seg->pathOffsets[i]),true);
      }
    }
    remainingRecords.reserve(index.records.size());
    for(const auto& record:index.records)
      if(!requestedSet.count(normalize_path(record.path)))remainingRecords.push_back(record);
    nextDeleted=index.deletedPaths;nextDeleted.reserve(nextDeleted.size()+found.size());
    nextReplaced=index.replacedPaths;
    result.removedPaths.reserve(found.size());
    for(const auto& item:requested){
      if(!found.count(item.normalized))continue;
      nextDeleted.insert(item.normalized);nextReplaced.erase(item.normalized);result.removedPaths.push_back(item.original);
    }
  }
  if(async_cancellation_checkpoint(cancellation,error))return false;
  if(testHooks){
    DWORD delay=windows_env_test_delay_ms("FLOATING_CLOCK_NATIVE_BATCH_DELETE_DELAY_MS_TEST");
    if(delay)Sleep(delay);
    if(async_cancellation_checkpoint(cancellation,error))return false;
    if(windows_env_flag_enabled("FLOATING_CLOCK_NATIVE_FAIL_BATCH_DELETE_BEFORE_COMMIT_TEST")){
      error="Injected batch delete failure before commit";return false;
    }
  }
  if(cancellation)cancellation->markPreCommit();
  if(async_cancellation_checkpoint(cancellation,error))return false;
  {
    std::unique_lock<std::shared_mutex> lk(index.mutex);
    index.records.swap(remainingRecords);index.deletedPaths.swap(nextDeleted);index.replacedPaths.swap(nextReplaced);
    for(const auto& normalized:found)index.pathIndexMap.erase(make_path_key(normalized));
    if(!result.removedPaths.empty())index.dirty.store(true);
  }
  return true;
}

static napi_value make_batch_delete_result(
    napi_env env,const BatchDeleteResult& deleted,size_t requestedCount){
  napi_value result,items;napi_create_object(env,&result);napi_create_array_with_length(env,deleted.removedPaths.size(),&items);
  for(size_t i=0;i<deleted.removedPaths.size();i++){
    napi_value item;napi_create_string_utf8(env,deleted.removedPaths[i].c_str(),NAPI_AUTO_LENGTH,&item);napi_set_element(env,items,(uint32_t)i,item);
  }
  set_bool(env,result,"ok",true);set_int64(env,result,"removedCount",(int64_t)deleted.removedPaths.size());
  set_int64(env,result,"missingCount",(int64_t)requestedCount-(int64_t)deleted.removedPaths.size());
  set_int64(env,result,"remainingCount",deleted.remainingCount);napi_set_named_property(env,result,"removedPaths",items);
  return result;
}

static napi_value DeleteIndexPaths(napi_env env,napi_callback_info info){
  try{
    auto& context=get_addon_context(env);
    size_t argc=1;napi_value argv[1];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
    if(argc<1)return native_error(env,"deleteIndexPaths requires a path array");
    std::vector<BatchDeleteRequestedPath> requested;std::unordered_set<std::string> requestedSet;std::string error;
    if(!parse_batch_delete_paths(env,argv[0],"deleteIndexPaths",requested,requestedSet,error))return native_error(env,error.c_str());
    std::string busyOperation;auto writeLease=try_acquire_index_writer(context.index,"edit-delete-batch",busyOperation);
    if(!writeLease){auto busy=index_writer_busy_error(busyOperation);return native_error(env,busy.c_str());}
    BatchDeleteResult deleted;
    if(!apply_batch_delete(*context.index,requested,requestedSet,deleted,{},error,false))return native_error(env,error.c_str());
    return make_batch_delete_result(env,deleted,requested.size());
  }catch(const std::exception& e){return native_error(env,e.what());}catch(...){return native_error(env,"deleteIndexPaths error");}
}

struct DeleteIndexPathsAsyncData{
  napi_async_work work=nullptr;napi_deferred deferred=nullptr;
  std::shared_ptr<AsyncWorkRegistry> registry;
  std::shared_ptr<AsyncCancellationToken> cancellation=std::make_shared<AsyncCancellationToken>();
  std::shared_ptr<IndexRuntime> index;
  std::shared_ptr<IndexWriteLease> writeLease;
  std::vector<std::string> inputPaths;
  std::vector<BatchDeleteRequestedPath> requested;
  std::unordered_set<std::string> requestedSet;
  BatchDeleteResult deleted;
  bool ok=false,committed=false;
  size_t requestedCount=0;
  std::shared_ptr<IndexExportCursor> cursor;
  std::string token;
  std::string error;
};

static void DeleteIndexPathsAsyncExecute(napi_env,void* data){
  auto* d=static_cast<DeleteIndexPathsAsyncData*>(data);
  struct Cleanup{DeleteIndexPathsAsyncData* d;~Cleanup(){
    std::vector<std::string>().swap(d->inputPaths);
    std::vector<BatchDeleteRequestedPath>().swap(d->requested);std::unordered_set<std::string>().swap(d->requestedSet);
    if(!d->committed)std::vector<std::string>().swap(d->deleted.removedPaths);
  }}cleanup{d};
  try{
    d->cancellation->markStarted();
    if(async_cancellation_checkpoint(d->cancellation,d->error))return;
    if(!normalize_batch_delete_input_paths(d->inputPaths,d->requested,d->requestedSet,d->cancellation,d->error))return;
    if(!apply_batch_delete(*d->index,d->requested,d->requestedSet,d->deleted,d->cancellation,d->error,true))return;
    d->committed=true;d->ok=true;
    d->requestedCount=d->requested.size();
    if(d->cursor)d->cursor->paths.swap(d->deleted.removedPaths);
  }catch(const std::exception& e){d->error=e.what();}catch(...){d->error="deleteIndexPathsAsync error";}
}

static void DeleteIndexPathsAsyncComplete(napi_env env,napi_status status,void* data){
  auto* d=static_cast<DeleteIndexPathsAsyncData*>(data);
  if(d->committed&&d->ok){
    napi_value result;
    if(d->cursor){
      d->cursor->ready=true;napi_create_object(env,&result);set_bool(env,result,"ok",true);
      set_string(env,result,"cursor",d->token.c_str());set_int64(env,result,"removedCount",(int64_t)d->cursor->paths.size());
      set_int64(env,result,"missingCount",(int64_t)d->requestedCount-(int64_t)d->cursor->paths.size());set_int64(env,result,"remainingCount",d->deleted.remainingCount);
    }else result=make_batch_delete_result(env,d->deleted,d->requestedCount);
    napi_resolve_deferred(env,d->deferred,result);
  }else{
    napi_value reason;
    if(d->cursor)get_addon_context(env).exports.erase(d->token);
    const char* message=d->error.empty()?(status==napi_cancelled?"Batch deletion cancelled":"Batch deletion failed"):d->error.c_str();
    napi_create_string_utf8(env,message,NAPI_AUTO_LENGTH,&reason);napi_reject_deferred(env,d->deferred,reason);
  }
  finish_registered_async_work(env,d->registry,d->work);delete d;
}

static napi_value DeleteIndexPathsAsyncImpl(napi_env env,napi_callback_info info,bool paged){
  try{
    size_t argc=1;napi_value argv[1];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
    if(argc<1)return reject_missing_args(env,"deleteIndexPathsAsync requires a path array");
    auto& context=get_addon_context(env);auto* d=new DeleteIndexPathsAsyncData();
    d->registry=context.asyncWorks;d->index=context.index;
    if(!parse_batch_delete_input_paths(env,argv[0],"deleteIndexPathsAsync",d->inputPaths,d->error)){
      napi_value promise;napi_create_promise(env,&d->deferred,&promise);napi_value reason;
      napi_create_string_utf8(env,d->error.c_str(),NAPI_AUTO_LENGTH,&reason);napi_reject_deferred(env,d->deferred,reason);delete d;return promise;
    }
    std::string busyOperation;d->writeLease=try_acquire_index_writer(context.index,"edit-delete-batch-async",busyOperation);
    if(!d->writeLease){delete d;return reject_index_writer_busy(env,busyOperation);}
    if(paged){
      size_t bytes=d->inputPaths.size()*sizeof(std::string);
      for(const auto& input:d->inputPaths)bytes+=input.size();
      if(bytes>INDEX_EXPORT_MAX_BYTES){delete d;return reject_missing_args(env,"Batch deletion exceeds the 128 MiB export safety limit");}
      try{d->cursor=std::make_shared<IndexExportCursor>();d->cursor->pathResult=true;d->token=reserve_index_export(context,d->cursor);}catch(...){delete d;throw;}
    }
    napi_value promise;napi_create_promise(env,&d->deferred,&promise);
    auto status=create_registered_async_work(env,d->registry,"fast_scanner:deleteIndexPathsAsync",
                                             DeleteIndexPathsAsyncExecute,DeleteIndexPathsAsyncComplete,d,&d->work,d->cancellation);
    if(status==napi_ok)status=queue_registered_async_work(env,d->registry,&d->work);
    if(status!=napi_ok){napi_value reason;napi_create_string_utf8(env,"Failed to queue async batch deletion",NAPI_AUTO_LENGTH,&reason);
      if(d->cursor)context.exports.erase(d->token);napi_reject_deferred(env,d->deferred,reason);delete d;}
    return promise;
  }catch(const std::exception& e){return reject_missing_args(env,e.what());}
  catch(...){return reject_missing_args(env,"deleteIndexPathsAsync error");}
}
static napi_value DeleteIndexPathsAsync(napi_env env,napi_callback_info info){return DeleteIndexPathsAsyncImpl(env,info,false);}
static napi_value DeleteIndexPathsPagedAsync(napi_env env,napi_callback_info info){return DeleteIndexPathsAsyncImpl(env,info,true);}

static napi_value PurgeIndexPathPrefix(napi_env env,napi_callback_info info){
  try{
    auto& context=get_addon_context(env);auto& index=*context.index;
    std::string busyOperation;auto writeLease=try_acquire_index_writer(context.index,"edit-purge",busyOperation);
    if(!writeLease){auto error=index_writer_busy_error(busyOperation);return native_error(env,error.c_str());}
    size_t argc=1;napi_value argv[1];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
    std::string prefix=argc>=1?normalize_path(get_string(env,argv[0])):"";
    napi_value result;napi_create_object(env,&result);
    if(prefix.size()<4){set_bool(env,result,"ok",false);set_string(env,result,"error","Unsafe index prefix");return result;}
    auto matches=[&](const std::string& normalized){return path_matches_prefix(normalized,prefix);};
    int64_t removed=0;
    std::unique_lock<std::shared_mutex> lk(index.mutex);
    std::unordered_set<std::string> matched;
    for(const auto& rec:index.records){std::string np=normalize_path(rec.path);if(matches(np))matched.insert(np);}
    for(const auto& seg:index.segments){
      if(!seg||!seg->view)continue;
      for(uint64_t i=0;i<seg->recordCount;i++){
        std::string np=normalize_path(std::string(seg->pathBytes+seg->pathOffsets[i]));
        if(matches(np)&&!index.deletedPaths.count(np))matched.insert(np);
      }
    }
    index.records.erase(std::remove_if(index.records.begin(),index.records.end(),[&](const ImageRecord& rec){
      return matches(normalize_path(rec.path));
    }),index.records.end());
    for(const auto& np:matched){
      index.deletedPaths.insert(np);index.replacedPaths.erase(np);index.pathIndexMap.erase(make_path_key(np));removed++;
    }
    for(auto it=index.failedPathMap.begin();it!=index.failedPathMap.end();){
      if(matches(it->first))it=index.failedPathMap.erase(it);else ++it;
    }
    if(removed>0)index.dirty.store(true);
    set_bool(env,result,"ok",true);set_int64(env,result,"removedCount",removed);return result;
  }catch(const std::exception& e){return native_error(env,e.what());}
  catch(...){return native_error(env,"purgeIndexPathPrefix error");}
}

static napi_value PurgeIndexPathSegment(napi_env env,napi_callback_info info){
  try{
    auto& context=get_addon_context(env);auto& index=*context.index;
    std::string busyOperation;auto writeLease=try_acquire_index_writer(context.index,"edit-purge-segment",busyOperation);
    if(!writeLease){auto error=index_writer_busy_error(busyOperation);return native_error(env,error.c_str());}
    size_t argc=1;napi_value argv[1];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
    std::string name=argc>=1?normalize_segment_name(get_string(env,argv[0])):"";
    napi_value result;napi_create_object(env,&result);
    if(name.empty()){set_bool(env,result,"ok",false);set_string(env,result,"error","Invalid directory name");return result;}
    const std::string needle="\\"+name+"\\";
    auto matches=[&](const std::string& normalized){return normalized.find(needle)!=std::string::npos;};
    int64_t removed=0;
    std::unique_lock<std::shared_mutex> lk(index.mutex);
    std::unordered_set<std::string> matched;
    for(const auto& rec:index.records){std::string np=normalize_path(rec.path);if(matches(np))matched.insert(np);}
    for(const auto& seg:index.segments){
      if(!seg||!seg->view)continue;
      for(uint64_t i=0;i<seg->recordCount;i++){
        std::string np=normalize_path(std::string(seg->pathBytes+seg->pathOffsets[i]));
        if(matches(np)&&!index.deletedPaths.count(np))matched.insert(np);
      }
    }
    index.records.erase(std::remove_if(index.records.begin(),index.records.end(),[&](const ImageRecord& rec){
      return matches(normalize_path(rec.path));
    }),index.records.end());
    for(const auto& np:matched){
      index.deletedPaths.insert(np);index.replacedPaths.erase(np);index.pathIndexMap.erase(make_path_key(np));removed++;
    }
    for(auto it=index.failedPathMap.begin();it!=index.failedPathMap.end();){
      if(matches(it->first))it=index.failedPathMap.erase(it);else ++it;
    }
    if(removed>0)index.dirty.store(true);
    set_bool(env,result,"ok",true);set_int64(env,result,"removedCount",removed);return result;
  }catch(const std::exception& e){return native_error(env,e.what());}
  catch(...){return native_error(env,"purgeIndexPathSegment error");}
}

static napi_value RepairIndexPath(napi_env env,napi_callback_info info){
  try{
    auto& context=get_addon_context(env);auto& index=*context.index;
    std::string busyOperation;auto writeLease=try_acquire_index_writer(context.index,"edit-repair",busyOperation);
    if(!writeLease){auto error=index_writer_busy_error(busyOperation);return native_error(env,error.c_str());}
    size_t argc=2;napi_value argv[2];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
    if(argc<2)return native_error(env,"repairIndexPath requires oldPath and newPath");
    std::string oldPath=get_string(env,argv[0]),newPath=get_string(env,argv[1]);
    std::string oldNp=normalize_path(oldPath),newNp=normalize_path(newPath);napi_value result;napi_create_object(env,&result);
    auto newMeta=file_meta(newPath);
    if(newMeta.first<=0){set_bool(env,result,"ok",false);set_string(env,result,"error","New source file does not exist");return result;}
    std::unique_lock<std::shared_mutex> lk(index.mutex);
    ImageRecord existing;bool fromSegment=false;
    if(!find_effective_record_locked(index,oldNp,existing,fromSegment)){set_bool(env,result,"ok",false);set_string(env,result,"error","Old indexed path not found");return result;}
    ImageRecord conflict;bool conflictFromSegment=false;
    if(oldNp!=newNp&&find_effective_record_locked(index,newNp,conflict,conflictFromSegment)){set_bool(env,result,"ok",false);set_string(env,result,"error","New path is already indexed");return result;}
    if(existing.fileSize>0&&newMeta.first!=existing.fileSize){set_bool(env,result,"ok",false);set_string(env,result,"error","New file size differs; use Update instead of path repair");return result;}
    index.records.erase(std::remove_if(index.records.begin(),index.records.end(),[&](const ImageRecord& rec){return normalize_path(rec.path)==oldNp;}),index.records.end());
    index.deletedPaths.insert(oldNp);index.replacedPaths.erase(oldNp);index.pathIndexMap.erase(make_path_key(oldNp));
    existing.id=index.nextId.fetch_add(1);existing.path=newPath;existing.fileSize=newMeta.first;existing.modifiedTime=newMeta.second;
    index.records.push_back(existing);index.pathIndexMap[make_path_key(newNp)]={existing.fileSize,existing.modifiedTime,false};
    index.dirty.store(true);set_bool(env,result,"ok",true);set_string(env,result,"oldPath",oldPath.c_str());set_string(env,result,"newPath",newPath.c_str());return result;
  }catch(const std::exception& e){return native_error(env,e.what());}catch(...){return native_error(env,"repairIndexPath error");}
}

static napi_value UpsertIndexRecord(napi_env env,napi_callback_info info){
  try{
    auto& context=get_addon_context(env);auto& index=*context.index;
    std::string busyOperation;auto writeLease=try_acquire_index_writer(context.index,"edit-upsert",busyOperation);
    if(!writeLease){auto error=index_writer_busy_error(busyOperation);return native_error(env,error.c_str());}
    size_t argc=7;napi_value argv[7];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
    if(argc<7)return native_error(env,"upsertIndexRecord requires 7 arguments");
    ImageRecord rec;rec.path=get_string(env,argv[0]);rec.width=get_int32(env,argv[1]);rec.height=get_int32(env,argv[2]);
    rec.fileSize=(int64_t)get_double(env,argv[3]);rec.modifiedTime=(int64_t)get_double(env,argv[4]);
    rec.diffHash64=parse_hex64(get_string(env,argv[5]));rec.dctHash64=parse_hex64(get_string(env,argv[6]));rec.channels=0;
    std::string np=normalize_path(rec.path);napi_value result;napi_create_object(env,&result);
    std::unique_lock<std::shared_mutex> lk(index.mutex);
    ImageRecord existing;bool fromSegment=false;
    bool found=find_effective_record_locked(index,np,existing,fromSegment);
    index.records.erase(std::remove_if(index.records.begin(),index.records.end(),[&](const ImageRecord& item){return normalize_path(item.path)==np;}),index.records.end());
    if(found&&(fromSegment||index.replacedPaths.count(np)))index.replacedPaths.insert(np);
    index.deletedPaths.erase(np);rec.id=index.nextId.fetch_add(1);index.records.push_back(rec);
    index.pathIndexMap[make_path_key(np)]={rec.fileSize,rec.modifiedTime,false};index.dirty.store(true);
    set_bool(env,result,"ok",true);set_string(env,result,"path",rec.path.c_str());return result;
  }catch(const std::exception& e){return native_error(env,e.what());}catch(...){return native_error(env,"upsertIndexRecord error");}
}

static napi_value SearchByHash(napi_env env,napi_callback_info info){
  try{size_t argc=5;napi_value argv[5];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
  if(argc<3)return native_error(env,"searchByHash requires hash, threshold, topK");
  auto& index=*get_addon_context(env).index;
  std::string hh=get_string(env,argv[0]);int th=std::clamp(get_int32(env,argv[1]),0,64),tk=get_int32(env,argv[2]);
  std::string sm=argc>=4?get_string(env,argv[3]):"balanced";size_t topK=(size_t)(tk>0?std::min(tk,1000):20);
  bool dctMode=(sm=="dct");
  std::string dctHex=argc>=5?get_string(env,argv[4]):"";
  uint64_t qh=parse_hex64(hh);uint64_t qDct=dctHex.empty()?0:parse_hex64(dctHex);
  std::vector<SearchHit> hits;SearchMetrics m;m.fallbackUsed=false;
  auto t0=std::chrono::high_resolution_clock::now();
  if(sm=="recall")search_linear_by_hash(index,qh,th,topK,hits,m,qDct,false);
  else if(sm=="balanced")search_balanced_by_hash(index,qh,th,topK,hits,m,qDct,false);
  else if(sm=="dct")search_linear_by_hash(index,qh,th,topK,hits,m,qDct,true);
  else search_by_hash(index,qh,th,topK,hits,m,qDct,false);
  auto t1=std::chrono::high_resolution_clock::now();
  napi_value r;napi_create_object(env,&r);set_bool(env,r,"ok",true);set_string(env,r,"queryHash",hh.c_str());
  if(qDct!=0)set_string(env,r,"queryDctHash64",dctHex.c_str());
  set_int64(env,r,"scannedCount",(int64_t)m.scanned);set_int64(env,r,"candidateCount",(int64_t)m.candidates);
  set_double(env,r,"searchMs",std::chrono::duration<double,std::milli>(t1-t0).count());
  set_string(env,r,"mode",index.mode.c_str());set_string(env,r,"indexType",dctMode?"linear-dct":(m.indexType?m.indexType:"linear"));
  set_int64(env,r,"bucketSize",(int64_t)m.bucketSize);set_int32(env,r,"segmentCount",(int32_t)index.segments.size());
  set_int32(env,r,"searchedSegments",m.searchedSegments);
  napi_value fbv;napi_get_boolean(env,m.fallbackUsed,&fbv);napi_set_named_property(env,r,"fallbackUsed",fbv);
  napi_value arr;napi_create_array_with_length(env,hits.size(),&arr);
  for(size_t i=0;i<hits.size();i++){napi_value o;napi_create_object(env,&o);
    set_int64(env,o,"id",hits[i].id);set_string(env,o,"path",hits[i].path.c_str());set_double(env,o,"score",hits[i].score);
    set_int32(env,o,"distance",hits[i].distance);set_int32(env,o,"dctDistance",hits[i].dctDistance);
    set_int32(env,o,"width",hits[i].width);set_int32(env,o,"height",hits[i].height);
    set_int64(env,o,"fileSize",hits[i].fileSize);set_string(env,o,"diffHash64",hex64(hits[i].diffHash64).c_str());
    if(hits[i].dctHash64!=0)set_string(env,o,"dctHash64",hex64(hits[i].dctHash64).c_str());
    set_int32(env,o,"segmentId",hits[i].segmentId);napi_set_element(env,arr,i,o);}
  napi_set_named_property(env,r,"results",arr);set_int32(env,r,"resultCount",(int32_t)hits.size());return r;
  }catch(const std::exception& e){return native_error(env,e.what());}catch(...){return native_error(env,"searchByHash error");}
}

static napi_value SearchByImage(napi_env env,napi_callback_info info){
  try{size_t argc=4;napi_value argv[4];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
  if(argc<3)return native_error(env,"searchByImage requires filePath, threshold, topK");
  auto& index=*get_addon_context(env).index;
  std::string fp=get_string(env,argv[0]);int th=std::clamp(get_int32(env,argv[1]),0,64),tk=get_int32(env,argv[2]);napi_value r;napi_create_object(env,&r);
  std::string sm=argc>=4?get_string(env,argv[3]):"balanced";size_t topK=(size_t)(tk>0?std::min(tk,1000):20);
  bool dctMode=(sm=="dct");
  std::vector<uint8_t> fb;if(!read_file_bytes(fp,fb)){set_bool(env,r,"ok",false);set_string(env,r,"error","Cannot read query");return r;}
  if(fb.size()>MAX_QUERY_IMAGE_BYTES){set_bool(env,r,"ok",false);set_string(env,r,"error","Image file too large");return r;}
  HashResultV1 qhr;
  if(!decode_and_hash_dual(fb.data(),fb.size(),qhr,fp)){
    set_bool(env,r,"ok",false);
    set_string(env,r,"error",qhr.decodeKind==DecodeKind::UNSUPPORTED?"Unsupported image format":decode_failure_reason());
    return r;
  }
  uint64_t qh=qhr.diffHash64;
  uint64_t qdct=qhr.dctHash64;
  std::vector<SearchHit> hits;SearchMetrics m;m.fallbackUsed=false;
  auto t0=std::chrono::high_resolution_clock::now();
  if(sm=="recall")search_linear_by_hash(index,qh,th,topK,hits,m,qdct,false);
  else if(sm=="balanced")search_balanced_by_hash(index,qh,th,topK,hits,m,qdct,false);
  else if(sm=="dct")search_linear_by_hash(index,qh,th,topK,hits,m,qdct,true);
  else search_by_hash(index,qh,th,topK,hits,m,qdct,false);
  auto t1=std::chrono::high_resolution_clock::now();set_bool(env,r,"ok",true);
  set_string(env,r,"queryHash",hex64(qh).c_str());
  set_string(env,r,"queryDctHash64",hex64(qdct).c_str());
  set_int64(env,r,"scannedCount",(int64_t)m.scanned);set_int64(env,r,"candidateCount",(int64_t)m.candidates);
  set_double(env,r,"searchMs",std::chrono::duration<double,std::milli>(t1-t0).count());
  set_string(env,r,"mode",index.mode.c_str());set_string(env,r,"indexType",dctMode?"linear-dct":(m.indexType?m.indexType:"linear"));
  set_int64(env,r,"bucketSize",(int64_t)m.bucketSize);set_int32(env,r,"segmentCount",(int32_t)index.segments.size());
  set_int32(env,r,"searchedSegments",m.searchedSegments);
  napi_value fbv;napi_get_boolean(env,m.fallbackUsed,&fbv);napi_set_named_property(env,r,"fallbackUsed",fbv);
  napi_value arr;napi_create_array_with_length(env,hits.size(),&arr);
  for(size_t i=0;i<hits.size();i++){napi_value o;napi_create_object(env,&o);
    set_int64(env,o,"id",hits[i].id);set_string(env,o,"path",hits[i].path.c_str());set_double(env,o,"score",hits[i].score);
    set_int32(env,o,"distance",hits[i].distance);set_int32(env,o,"dctDistance",hits[i].dctDistance);
    set_int32(env,o,"width",hits[i].width);set_int32(env,o,"height",hits[i].height);
    set_int64(env,o,"fileSize",hits[i].fileSize);set_string(env,o,"diffHash64",hex64(hits[i].diffHash64).c_str());
    if(hits[i].dctHash64!=0)set_string(env,o,"dctHash64",hex64(hits[i].dctHash64).c_str());napi_set_element(env,arr,i,o);}
  napi_set_named_property(env,r,"results",arr);set_int32(env,r,"resultCount",(int32_t)hits.size());return r;
  }catch(const std::exception& e){return native_error(env,e.what());}catch(...){return native_error(env,"searchByImage error");}
}

// ===== Manifest save/load =====
static std::string json_escape(const std::string& s){std::string o;for(char c:s){if(c=='\\'||c=='"')o+='\\';o+=c;}return o;}
static std::string json_unescape(const std::string& s){
  std::string out;out.reserve(s.size());bool escaped=false;
  for(char c:s){if(escaped){out+=c;escaped=false;}else if(c=='\\')escaped=true;else out+=c;}
  if(escaped)out+='\\';return out;
}

// The old manifest loader searched the entire JSON text for `"file":"`.
// Besides rejecting a legitimate schema-v2 empty manifest, that could mistake
// an unrelated nested `file` property for a segment. Keep this small parser
// dependency-free, but validate the complete JSON object and read files only
// from the top-level `segments` array.
class ManifestJsonReader{
 public:
  explicit ManifestJsonReader(const std::string& input):input_(input){}

  bool parse(int& schemaVersion,std::vector<std::string>& segmentFiles,std::string& error){
    bool schemaSeen=false,segmentsSeen=false;
    skipWhitespace();
    if(!consume('{'))return fail(error,"Malformed manifest.json");
    skipWhitespace();
    if(!consume('}')){
      for(;;){
        std::string key;
        if(!parseString(key)||!consume(':'))return fail(error,"Malformed manifest.json");
        if(key=="schemaVersion"){
          if(schemaSeen)return fail(error,"Manifest contains duplicate schemaVersion");
          schemaSeen=true;std::string number;
          if(!parseNumber(number)||(number!="1"&&number!="2"))return fail(error,"Unsupported manifest schemaVersion");
          schemaVersion=number=="2"?2:1;
        }else if(key=="segments"){
          if(segmentsSeen)return fail(error,"Manifest contains duplicate segments");
          segmentsSeen=true;
          if(!parseSegments(segmentFiles,error))return false;
        }else if(!skipValue(0))return fail(error,"Malformed manifest.json");
        skipWhitespace();
        if(consume('}'))break;
        if(!consume(','))return fail(error,"Malformed manifest.json");
      }
    }
    skipWhitespace();
    if(position_!=input_.size()||!segmentsSeen)return fail(error,"Manifest has no valid segments array");
    if(segmentFiles.empty()&&(!schemaSeen||schemaVersion!=2))return fail(error,"Empty manifest requires schemaVersion 2");
    return true;
  }

 private:
  const std::string& input_;
  size_t position_=0;

  static bool fail(std::string& error,const char* message){error=message;return false;}
  void skipWhitespace(){while(position_<input_.size()&&
    (input_[position_]==' '||input_[position_]=='\t'||input_[position_]=='\r'||input_[position_]=='\n'))position_++;}
  bool consume(char expected){skipWhitespace();if(position_>=input_.size()||input_[position_]!=expected)return false;position_++;return true;}
  static int hexDigit(char value){
    if(value>='0'&&value<='9')return value-'0';
    if(value>='a'&&value<='f')return value-'a'+10;
    if(value>='A'&&value<='F')return value-'A'+10;
    return -1;
  }
  bool parseHex4(uint32_t& value){
    if(position_+4>input_.size())return false;value=0;
    for(int index=0;index<4;index++){int digit=hexDigit(input_[position_++]);if(digit<0)return false;value=(value<<4)|(uint32_t)digit;}
    return true;
  }
  static void appendUtf8(std::string& output,uint32_t codepoint){
    if(codepoint<=0x7f)output.push_back((char)codepoint);
    else if(codepoint<=0x7ff){output.push_back((char)(0xc0|(codepoint>>6)));output.push_back((char)(0x80|(codepoint&0x3f)));}
    else if(codepoint<=0xffff){output.push_back((char)(0xe0|(codepoint>>12)));output.push_back((char)(0x80|((codepoint>>6)&0x3f)));output.push_back((char)(0x80|(codepoint&0x3f)));}
    else{output.push_back((char)(0xf0|(codepoint>>18)));output.push_back((char)(0x80|((codepoint>>12)&0x3f)));output.push_back((char)(0x80|((codepoint>>6)&0x3f)));output.push_back((char)(0x80|(codepoint&0x3f)));}
  }
  bool parseString(std::string& output){
    skipWhitespace();if(position_>=input_.size()||input_[position_]!='"')return false;position_++;output.clear();
    while(position_<input_.size()){
      unsigned char value=(unsigned char)input_[position_++];
      if(value=='"')return true;
      if(value<0x20)return false;
      if(value!='\\'){output.push_back((char)value);continue;}
      if(position_>=input_.size())return false;char escaped=input_[position_++];
      switch(escaped){
        case '"':output.push_back('"');break;case '\\':output.push_back('\\');break;case '/':output.push_back('/');break;
        case 'b':output.push_back('\b');break;case 'f':output.push_back('\f');break;case 'n':output.push_back('\n');break;
        case 'r':output.push_back('\r');break;case 't':output.push_back('\t');break;
        case 'u':{
          uint32_t codepoint=0;if(!parseHex4(codepoint))return false;
          if(codepoint>=0xd800&&codepoint<=0xdbff){
            if(position_+2>input_.size()||input_[position_]!='\\'||input_[position_+1]!='u')return false;position_+=2;
            uint32_t low=0;if(!parseHex4(low)||low<0xdc00||low>0xdfff)return false;
            codepoint=0x10000+((codepoint-0xd800)<<10)+(low-0xdc00);
          }else if(codepoint>=0xdc00&&codepoint<=0xdfff)return false;
          appendUtf8(output,codepoint);break;
        }
        default:return false;
      }
    }
    return false;
  }
  bool parseNumber(std::string& output){
    skipWhitespace();size_t start=position_;
    if(position_<input_.size()&&input_[position_]=='-')position_++;
    if(position_>=input_.size())return false;
    if(input_[position_]=='0')position_++;
    else if(input_[position_]>='1'&&input_[position_]<='9')while(position_<input_.size()&&input_[position_]>='0'&&input_[position_]<='9')position_++;
    else return false;
    if(position_<input_.size()&&input_[position_]=='.'){
      position_++;size_t digits=position_;while(position_<input_.size()&&input_[position_]>='0'&&input_[position_]<='9')position_++;
      if(digits==position_)return false;
    }
    if(position_<input_.size()&&(input_[position_]=='e'||input_[position_]=='E')){
      position_++;if(position_<input_.size()&&(input_[position_]=='+'||input_[position_]=='-'))position_++;
      size_t digits=position_;while(position_<input_.size()&&input_[position_]>='0'&&input_[position_]<='9')position_++;
      if(digits==position_)return false;
    }
    output=input_.substr(start,position_-start);return true;
  }
  bool skipValue(int depth){
    if(depth>64)return false;skipWhitespace();if(position_>=input_.size())return false;
    if(input_[position_]=='"'){std::string ignored;return parseString(ignored);}
    if(input_[position_]=='{'){
      position_++;skipWhitespace();if(consume('}'))return true;
      for(;;){std::string key;if(!parseString(key)||!consume(':')||!skipValue(depth+1))return false;
        if(consume('}'))return true;if(!consume(','))return false;}
    }
    if(input_[position_]=='['){
      position_++;skipWhitespace();if(consume(']'))return true;
      for(;;){if(!skipValue(depth+1))return false;if(consume(']'))return true;if(!consume(','))return false;}
    }
    for(const char* literal:{"true","false","null"}){
      size_t length=strlen(literal);if(input_.compare(position_,length,literal)==0){position_+=length;return true;}
    }
    std::string ignored;return parseNumber(ignored);
  }
  bool parseSegment(std::string& filePath,std::string& error){
    if(!consume('{'))return fail(error,"Manifest segment is not an object");
    bool fileSeen=false;skipWhitespace();
    if(!consume('}')){
      for(;;){
        std::string key;if(!parseString(key)||!consume(':'))return fail(error,"Malformed manifest segment");
        if(key=="file"){
          if(fileSeen||!parseString(filePath))return fail(error,"Manifest segment has an invalid file");fileSeen=true;
        }else if(!skipValue(1))return fail(error,"Malformed manifest segment");
        if(consume('}'))break;if(!consume(','))return fail(error,"Malformed manifest segment");
      }
    }
    if(!fileSeen||filePath.empty()||filePath.size()>32768||filePath.find('\0')!=std::string::npos)
      return fail(error,"Manifest segment has an invalid file");
    return true;
  }
  bool parseSegments(std::vector<std::string>& segmentFiles,std::string& error){
    if(!consume('['))return fail(error,"Manifest segments is not an array");
    if(consume(']'))return true;
    for(;;){
      if(segmentFiles.size()>=65535)return fail(error,"Manifest has too many segments");
      std::string filePath;if(!parseSegment(filePath,error))return false;segmentFiles.push_back(std::move(filePath));
      if(consume(']'))return true;if(!consume(','))return fail(error,"Malformed manifest segments array");
    }
  }
};

static bool parse_manifest_json(const std::string& input,int& schemaVersion,
                                std::vector<std::string>& segmentFiles,std::string& error){
  ManifestJsonReader reader(input);return reader.parse(schemaVersion,segmentFiles,error);
}

struct ManifestPathBoundary{
  fs::path rootPath;
  fs::path canonicalRoot;
  HANDLE rootHandle=INVALID_HANDLE_VALUE;
  std::vector<HANDLE> heldDirectoryHandles;
  std::unordered_set<std::wstring> heldDirectoryKeys;
  ManifestPathBoundary()=default;
  ManifestPathBoundary(const ManifestPathBoundary&)=delete;
  ManifestPathBoundary& operator=(const ManifestPathBoundary&)=delete;
  ~ManifestPathBoundary(){for(HANDLE handle:heldDirectoryHandles)if(handle!=INVALID_HANDLE_VALUE)CloseHandle(handle);
    if(rootHandle!=INVALID_HANDLE_VALUE)CloseHandle(rootHandle);}
};

static bool manifest_handle_is_within_root(HANDLE handle,const ManifestPathBoundary& boundary);

static std::wstring manifest_path_compare_key(const fs::path& value){
  std::wstring key=value.lexically_normal().native();
  if(key.rfind(L"\\\\?\\UNC\\",0)==0)key=L"\\\\"+key.substr(8);
  else if(key.rfind(L"\\\\?\\",0)==0)key=key.substr(4);
  std::replace(key.begin(),key.end(),L'/',L'\\');
  while(key.size()>3&&key.back()==L'\\')key.pop_back();
  std::transform(key.begin(),key.end(),key.begin(),[](wchar_t value){return (wchar_t)towlower(value);});
  return key;
}

static bool manifest_path_is_within(const fs::path& root,const fs::path& candidate){
  const std::wstring rootKey=manifest_path_compare_key(root),candidateKey=manifest_path_compare_key(candidate);
  return candidateKey==rootKey||(candidateKey.size()>rootKey.size()&&
    candidateKey.compare(0,rootKey.size(),rootKey)==0&&candidateKey[rootKey.size()]==L'\\');
}

static bool prepare_manifest_path_boundary(const std::string& rootDir,bool createRoot,
                                           ManifestPathBoundary& boundary,std::string& error){
  if(rootDir.empty()||rootDir.size()>32768||rootDir.find('\0')!=std::string::npos){error="Invalid manifest root path";return false;}
  std::error_code ec;
  boundary.rootPath=fs::absolute(path_from_utf8(rootDir),ec).lexically_normal();
  if(ec||boundary.rootPath.empty()){error="Invalid manifest root path";return false;}
  if(createRoot){fs::create_directories(boundary.rootPath,ec);if(ec){error="Cannot create manifest root";return false;}}
  if(!fs::exists(boundary.rootPath,ec)||ec||!fs::is_directory(boundary.rootPath,ec)||ec){
    error="Manifest root is not a directory";return false;
  }
  boundary.canonicalRoot=fs::canonical(boundary.rootPath,ec);
  if(ec||boundary.canonicalRoot.empty()){error="Cannot resolve manifest root";return false;}
  boundary.rootHandle=CreateFileW(boundary.canonicalRoot.c_str(),FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS,nullptr);
  if(boundary.rootHandle==INVALID_HANDLE_VALUE||!manifest_handle_is_within_root(boundary.rootHandle,boundary)){
    if(boundary.rootHandle!=INVALID_HANDLE_VALUE){CloseHandle(boundary.rootHandle);boundary.rootHandle=INVALID_HANDLE_VALUE;}
    error="Cannot lock manifest root boundary";return false;
  }
  return true;
}

static bool is_reserved_windows_component(const std::string& component){
  std::string base=component.substr(0,component.find('.'));
  std::transform(base.begin(),base.end(),base.begin(),[](unsigned char ch){return (char)toupper(ch);});
  if(base=="CON"||base=="PRN"||base=="AUX"||base=="NUL")return true;
  if(base.size()==4&&(base.rfind("COM",0)==0||base.rfind("LPT",0)==0)&&base[3]>='1'&&base[3]<='9')return true;
  return false;
}

static bool parse_safe_manifest_segment_relative(const std::string& manifestPath,
                                                 std::vector<std::string>& components,
                                                 std::string& normalizedRelative,std::string& error){
  if(manifestPath.empty()||manifestPath.size()>32768||manifestPath.find('\0')!=std::string::npos){
    error="Unsafe manifest segment path: empty or oversized path";return false;
  }
  if(MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,manifestPath.data(),(int)manifestPath.size(),nullptr,0)<=0){
    error="Unsafe manifest segment path: invalid UTF-8";return false;
  }
  std::string value=manifestPath;std::replace(value.begin(),value.end(),'\\','/');
  fs::path nativePath=path_from_utf8(manifestPath);
  if(value.empty()||value.front()=='/'||nativePath.is_absolute()||nativePath.has_root_name()||nativePath.has_root_directory()){
    error="Unsafe manifest segment path: absolute paths are not allowed";return false;
  }
  components.clear();size_t start=0;
  while(start<=value.size()){
    size_t end=value.find('/',start);std::string component=value.substr(start,end==std::string::npos?std::string::npos:end-start);
    if(component.empty()||component=="."||component==".."){
      error="Unsafe manifest segment path: empty, dot, and parent components are not allowed";return false;
    }
    if(component.find_first_of("<>:\"|?*")!=std::string::npos||component.back()=='.'||component.back()==' '||
       is_reserved_windows_component(component)||
       std::any_of(component.begin(),component.end(),[](unsigned char ch){return ch<0x20;})){
      error="Unsafe manifest segment path: invalid Windows path component";return false;
    }
    components.push_back(std::move(component));if(end==std::string::npos)break;start=end+1;
  }
  if(components.size()<2){error="Unsafe manifest segment path: expected segments/*.idx";return false;}
  std::string first=components.front();std::transform(first.begin(),first.end(),first.begin(),[](unsigned char ch){return (char)tolower(ch);});
  std::string leaf=components.back();std::transform(leaf.begin(),leaf.end(),leaf.begin(),[](unsigned char ch){return (char)tolower(ch);});
  if(first!="segments"||leaf.size()<=4||leaf.substr(leaf.size()-4)!=".idx"){
    error="Unsafe manifest segment path: expected segments/*.idx";return false;
  }
  normalizedRelative="segments";
  for(size_t index=1;index<components.size();index++)normalizedRelative+="/"+components[index];
  return true;
}

static bool path_component_is_reparse_point(const fs::path& value,bool& exists,std::string& error){
  DWORD attributes=GetFileAttributesW(value.c_str());
  if(attributes==INVALID_FILE_ATTRIBUTES){
    DWORD code=GetLastError();exists=false;
    if(code==ERROR_FILE_NOT_FOUND||code==ERROR_PATH_NOT_FOUND)return true;
    error="Cannot inspect manifest path component (Win32 "+std::to_string(code)+")";return false;
  }
  exists=true;
  if((attributes&FILE_ATTRIBUTE_REPARSE_POINT)!=0){error="Unsafe manifest path: reparse points are not allowed";return false;}
  return true;
}

static bool hold_manifest_directory(ManifestPathBoundary& boundary,const fs::path& directory,std::string& error){
  std::wstring key=manifest_path_compare_key(directory);
  if(boundary.heldDirectoryKeys.count(key))return true;
  HANDLE handle=CreateFileW(directory.c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,
                            OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
  if(handle==INVALID_HANDLE_VALUE){error="Cannot lock manifest directory";return false;}
  FILE_ATTRIBUTE_TAG_INFO tagInfo={};
  if(!GetFileInformationByHandleEx(handle,FileAttributeTagInfo,&tagInfo,sizeof(tagInfo))||
     (tagInfo.FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)!=0||!manifest_handle_is_within_root(handle,boundary)){
    CloseHandle(handle);error="Unsafe manifest directory handle";return false;
  }
  boundary.heldDirectoryKeys.insert(std::move(key));boundary.heldDirectoryHandles.push_back(handle);return true;
}

static bool resolve_manifest_segment_path(ManifestPathBoundary& boundary,const std::string& manifestPath,
                                          std::string& resolvedPath,std::string& normalizedRelative,
                                          std::string& error,bool requireExisting=true){
  std::vector<std::string> components;
  if(!parse_safe_manifest_segment_relative(manifestPath,components,normalizedRelative,error))return false;
  fs::path candidate=boundary.rootPath;
  for(size_t index=0;index<components.size();index++){
    candidate/=path_from_utf8(components[index]);bool exists=false;
    if(!path_component_is_reparse_point(candidate,exists,error)){
      error="Unsafe manifest segment path: "+error;return false;
    }
    if(requireExisting&&!exists){error="Manifest segment does not exist";return false;}
    if(exists){
      DWORD attributes=GetFileAttributesW(candidate.c_str());
      bool shouldBeDirectory=index+1<components.size();
      if(shouldBeDirectory&&(attributes&FILE_ATTRIBUTE_DIRECTORY)==0){error="Manifest segment parent is not a directory";return false;}
      if(!shouldBeDirectory&&(attributes&FILE_ATTRIBUTE_DIRECTORY)!=0){error="Manifest segment path is not a file";return false;}
      if(shouldBeDirectory&&!hold_manifest_directory(boundary,candidate,error))return false;
    }
  }
  std::error_code ec;
  fs::path checked=requireExisting?fs::canonical(candidate,ec):fs::weakly_canonical(candidate,ec);
  if(ec||!manifest_path_is_within(boundary.canonicalRoot,checked)){
    error="Unsafe manifest segment path: resolved path escapes manifest root";return false;
  }
  resolvedPath=wide_to_utf8(candidate.lexically_normal().wstring());return true;
}

static bool make_manifest_segment_reference(ManifestPathBoundary& boundary,const std::string& segmentPath,
                                            std::string& relativePath,std::string& resolvedPath,std::string& error){
  std::error_code ec;fs::path absolute=fs::absolute(path_from_utf8(segmentPath),ec).lexically_normal();
  if(ec){error="Unsafe loaded segment path";return false;}
  fs::path relative=fs::relative(absolute,boundary.rootPath,ec);
  if(ec){error="Unsafe loaded segment path";return false;}
  std::string relativeUtf8=wide_to_utf8(relative.generic_wstring());
  return resolve_manifest_segment_path(boundary,relativeUtf8,resolvedPath,relativePath,error,true);
}

static bool resolve_manifest_fixed_path(const ManifestPathBoundary& boundary,const char* fileName,
                                        bool requireExisting,fs::path& output,bool& exists,std::string& error){
  std::string name=fileName?fileName:"";
  if(name.empty()||name.find('/')!=std::string::npos||name.find('\\')!=std::string::npos||name=="."||name==".."){
    error="Invalid fixed manifest path";return false;
  }
  output=boundary.rootPath/path_from_utf8(name);
  if(!path_component_is_reparse_point(output,exists,error)){
    error="Unsafe "+name+": "+error;return false;
  }
  if(requireExisting&&!exists){error="Missing "+name;return false;}
  if(exists){
    DWORD attributes=GetFileAttributesW(output.c_str());
    if((attributes&FILE_ATTRIBUTE_DIRECTORY)!=0){error="Unsafe "+name+": expected a file";return false;}
    std::error_code ec;fs::path canonical=fs::canonical(output,ec);
    if(ec||!manifest_path_is_within(boundary.canonicalRoot,canonical)){error="Unsafe "+name+": path escapes manifest root";return false;}
  }
  return true;
}

static bool prepare_manifest_subdirectory(ManifestPathBoundary& boundary,const char* directoryName,
                                          bool createDirectory,fs::path& output,std::string& error){
  output=boundary.rootPath/path_from_utf8(directoryName);bool exists=false;
  if(!path_component_is_reparse_point(output,exists,error)){error="Unsafe manifest directory: "+error;return false;}
  std::error_code ec;
  if(!exists&&createDirectory){fs::create_directory(output,ec);if(ec){error="Cannot create manifest directory";return false;}exists=true;}
  if(!exists||!fs::is_directory(output,ec)||ec){error="Manifest directory is missing or invalid";return false;}
  fs::path canonical=fs::canonical(output,ec);
  if(ec||!manifest_path_is_within(boundary.canonicalRoot,canonical)){error="Unsafe manifest directory: path escapes manifest root";return false;}
  return hold_manifest_directory(boundary,output,error);
}

static bool manifest_handle_is_within_root(HANDLE handle,const ManifestPathBoundary& boundary){
  DWORD needed=GetFinalPathNameByHandleW(handle,nullptr,0,FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
  if(needed==0)return false;
  std::wstring value((size_t)needed,L'\0');DWORD written=GetFinalPathNameByHandleW(handle,value.data(),needed,FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
  if(written==0||written>=needed)return false;value.resize(written);
  return manifest_path_is_within(boundary.canonicalRoot,fs::path(value));
}

static bool write_fixed_manifest_temp(const ManifestPathBoundary& boundary,const char* fileName,
                                      const std::string& contents,fs::path& output,std::string& error){
  bool exists=false;
  if(!resolve_manifest_fixed_path(boundary,fileName,false,output,exists,error))return false;
  if(exists&&!DeleteFileW(output.c_str())){error="Cannot remove stale manifest temporary file";return false;}
  HANDLE handle=CreateFileW(output.c_str(),GENERIC_WRITE,0,nullptr,CREATE_NEW,
                            FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
  if(handle==INVALID_HANDLE_VALUE){error="Cannot create manifest temporary file";return false;}
  bool ok=manifest_handle_is_within_root(handle,boundary);size_t offset=0;
  while(ok&&offset<contents.size()){
    DWORD chunk=(DWORD)std::min<size_t>(contents.size()-offset,16*1024*1024),written=0;
    ok=WriteFile(handle,contents.data()+offset,chunk,&written,nullptr)!=0&&written==chunk;offset+=written;
  }
  if(ok)ok=FlushFileBuffers(handle)!=0;CloseHandle(handle);
  if(!ok){DeleteFileW(output.c_str());error="Cannot write manifest temporary file safely";return false;}
  return true;
}

static void apply_empty_manifest(IndexRuntime& index,const std::string& rootDir){
  unmap_index(index);
  {
    std::unique_lock<std::shared_mutex> lock(index.mutex);
    index.records.clear();index.dedupSet.clear();index.pathIndexMap.clear();index.failedPathMap.clear();
    index.replacedPaths.clear();index.deletedPaths.clear();
    index.mode="segment_mmap";index.type="prefix16";index.manifestPath=rootDir;
    index.indexedCount.store(0);index.failedCount.store(0);index.totalBytes.store(0);
  }
  {
    std::lock_guard<std::mutex> lock(index.usnMutex);
    index.usnStates.clear();index.usnStatePath=rootDir;
  }
  index.resetUsnScanStatus();index.dirty.store(false);index.nextId.store(1);
}
static std::string now_iso(){auto t=std::time(nullptr);char buf[32];strftime(buf,sizeof(buf),"%Y-%m-%dT%H:%M:%SZ",gmtime(&t));return buf;}

// ── Segment file writer (shared between full-save and append-save) ─
// Writes records to tmpPath, validates, renames to finalPath. Returns checksum via csOut.
static bool write_segment_file(const std::vector<ImageRecord>& records,
    const std::string& tmpPath, const std::string& finalPath, uint64_t& csOut, uint64_t& totalSizeOut,
    const std::shared_ptr<AsyncCancellationToken>& cancellation={}){
  struct TmpGuard{const std::string& path;bool keep=false;~TmpGuard(){if(!keep){std::error_code ec;fs::remove(path,ec);}}}tmpGuard{tmpPath};
  auto cancelled=[&](){return cancellation&&cancellation->isRequested();};
  if(cancelled())return false;
  uint64_t N=records.size();
  uint64_t poOff=sizeof(IdxHeader),pbOff=poOff+(N+1)*8,metaOff=pbOff;
  for(size_t i=0;i<records.size();i++){if((i&255)==0&&cancelled())return false;metaOff+=records[i].path.size()+1;}
  uint64_t diffHashOff=metaOff+N*sizeof(IdxMeta);
  uint64_t dctHashOff=diffHashOff+N*sizeof(uint64_t);
  uint64_t delBmpOff=dctHashOff+N*sizeof(uint64_t);
  uint64_t delBmpSz=(N+7)/8;
  uint64_t footerOff=delBmpOff+delBmpSz,totalSize=footerOff+sizeof(IdxFooter);
  totalSizeOut=totalSize;
  {std::fstream f(path_from_utf8(tmpPath),std::ios::binary|std::ios::in|std::ios::out|std::ios::trunc);
   if(!f){se_log("SEG_WRITE_OPEN_FAIL "+se_path(tmpPath));return false;}
   IdxHeader hdr={};memcpy(hdr.magic,"IMS1",4);hdr.version=4;hdr.recordCount=N;hdr.fileSize=totalSize;hdr.headerSize=sizeof(IdxHeader);
   hdr.pathOffsetsOffset=poOff;hdr.pathBytesOffset=pbOff;hdr.metadataOffset=metaOff;hdr.diffHashOffset=diffHashOff;hdr.footerOffset=footerOff;hdr.bodyChecksum=0;
   f.write((const char*)&hdr,sizeof(IdxHeader));uint64_t bStart=(uint64_t)f.tellp();
   auto w64=[&](uint64_t v){f.write((const char*)&v,8);};
   uint64_t off=0;for(size_t i=0;i<records.size();i++){if((i&255)==0&&cancelled())return false;auto& rec=records[i];w64(off);off+=rec.path.size()+1;}w64(off);
   for(size_t i=0;i<records.size();i++){if((i&255)==0&&cancelled())return false;auto& rec=records[i];f.write(rec.path.c_str(),rec.path.size()+1);}
   for(size_t i=0;i<records.size();i++){if((i&255)==0&&cancelled())return false;auto& rec=records[i];f.write((const char*)&rec.width,4);f.write((const char*)&rec.height,4);w64(rec.fileSize);w64(rec.modifiedTime);uint32_t z=0;f.write((const char*)&z,4);f.write((const char*)&z,4);}
   for(size_t i=0;i<records.size();i++){if((i&255)==0&&cancelled())return false;w64(records[i].diffHash64);}
   for(size_t i=0;i<records.size();i++){if((i&255)==0&&cancelled())return false;w64(records[i].dctHash64);}
   {std::vector<uint8_t> dbmp(delBmpSz,0);f.write((const char*)dbmp.data(),delBmpSz);}
   uint64_t bEnd=(uint64_t)f.tellp();std::vector<char> bBuf((size_t)(bEnd-bStart));f.seekp(bStart);f.read(bBuf.data(),bBuf.size());
   if(cancelled())return false;
   csOut=fnv64(bBuf.data(),bBuf.size());f.seekp(offsetof(IdxHeader,bodyChecksum));w64(csOut);f.seekp(0,std::ios::end);
   IdxFooter ftr={};memcpy(ftr.magic,"END\0",4);ftr.recordCount=N;ftr.version=4;f.write((const char*)&ftr,sizeof(IdxFooter));f.close();}
  // Validate
  {std::vector<uint8_t> vfy;if(!read_file_bytes(tmpPath,vfy)){se_log("SEG_VFY_READ_FAIL "+se_path(tmpPath));return false;}
   const IdxHeader* vh=(const IdxHeader*)vfy.data();if(memcmp(vh->magic,"IMS1",4)){se_log("SEG_VFY_MAGIC "+se_path(tmpPath));return false;}
   if(vh->version!=4||vh->recordCount!=N){se_log("SEG_VFY_HDR "+se_path(tmpPath));return false;}}
  if(cancelled())return false;
  // Atomic rename
  {std::error_code ec;fs::rename(tmpPath,finalPath,ec);if(ec){se_log("SEG_RENAME_FAIL "+se_path(tmpPath)+" -> "+se_path(finalPath));return false;}}
  tmpGuard.keep=true;
  return true;
}

// ── Load a single segment via mmap (returns shared_ptr, nullptr on failure) ─
static std::shared_ptr<SegmentView> mmap_segment(IndexRuntime& index,const std::string& segPath,
                                                const ManifestPathBoundary* boundary=nullptr){
  std::wstring wfp=utf8_to_wide(segPath);
  HANDLE hFile=CreateFileW(wfp.c_str(),GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);
  if(hFile==INVALID_HANDLE_VALUE)return nullptr;
  if(boundary&&!manifest_handle_is_within_root(hFile,*boundary)){CloseHandle(hFile);return nullptr;}
  LARGE_INTEGER li;GetFileSizeEx(hFile,&li);uint64_t fsz=(uint64_t)li.QuadPart;
  HANDLE hMap=CreateFileMappingW(hFile,NULL,PAGE_READONLY,0,0,NULL);
  if(!hMap){CloseHandle(hFile);return nullptr;}
  const char* view=(const char*)MapViewOfFile(hMap,FILE_MAP_READ,0,0,0);
  if(!view){CloseHandle(hMap);CloseHandle(hFile);return nullptr;}
  auto fail=[&]()->std::shared_ptr<SegmentView>{UnmapViewOfFile(view);CloseHandle(hMap);CloseHandle(hFile);return nullptr;};
  const IdxHeader* hdr=(const IdxHeader*)view;
  if(memcmp(hdr->magic,"IMS1",4))return fail();
  if(hdr->version<1||hdr->version>4)return fail();
  uint64_t n=hdr->recordCount,po=hdr->pathOffsetsOffset,pb=hdr->pathBytesOffset,mo=hdr->metadataOffset,ho=hdr->diffHashOffset;
  uint64_t metaSz=(hdr->version>=2)?sizeof(IdxMeta):24;
  uint64_t dctOff=ho+n*8,delOff=dctOff+n*8,delSz=(n+7)/8;
  if(po+(n+1)*8>fsz||mo+n*metaSz>fsz||ho+n*8>fsz)return fail();
  if(hdr->version>=3&&dctOff+n*8>fsz)return fail();
  if(hdr->version>=4&&delOff+delSz>fsz)return fail();
  if(!(sizeof(IdxHeader)<=po&&po<pb&&pb<mo&&mo<ho&&ho<=fsz-sizeof(IdxFooter)))return fail();
  const IdxFooter* ftr=(const IdxFooter*)(view+fsz-sizeof(IdxFooter));
  if(memcmp(ftr->magic,"END\0",4))return fail();
  if(n>0){const uint64_t* poff=(const uint64_t*)(view+po);if(poff[0]!=0)return fail();}
  if(hdr->version>=2&&hdr->bodyChecksum!=0){uint64_t bodySz=hdr->footerOffset-sizeof(IdxHeader);
    if(fnv64(view+sizeof(IdxHeader),(size_t)bodySz)!=hdr->bodyChecksum)return fail();}
  auto seg=std::make_shared<SegmentView>();seg->path=segPath;seg->version=hdr->version;seg->recordCount=n;seg->fileSize=fsz;seg->bodyChecksum=hdr->bodyChecksum;
  seg->fileHandle=hFile;seg->mappingHandle=hMap;seg->view=view;
  seg->pathOffsets=(const uint64_t*)(view+po);seg->pathBytes=view+pb;seg->metadata=(const uint8_t*)(view+mo);seg->diffHash=(const uint64_t*)(view+ho);
  seg->dctHash=(hdr->version>=3)?(const uint64_t*)(view+dctOff):nullptr;
  seg->deletedBitmap=(hdr->version>=4)?(const uint8_t*)(view+delOff):nullptr;
  seg->deletedBitmapBytes=(hdr->version>=4)?delSz:0;
  build_segment_local_index(seg);
  // Populate path index map
  {const char* pbBase=view+pb;const uint64_t* poBase=(const uint64_t*)(view+po);auto* metaBase=(const IdxMetaFwd*)(view+mo);
   for(uint64_t i=0;i<n;i++){
     std::string sp(pbBase+poBase[i]);std::string np=normalize_path(sp);
     PathIndexEntry pe;pe.fileSize=metaBase[i].fileSize;pe.modifiedTime=metaBase[i].modifiedTime;pe.fromSegment=true;
     index.pathIndexMap[make_path_key(np)]=pe;
   }}
  return seg;
}

// ── Overlay persistence (replaced/deleted paths) ────────
static bool save_overlay_snapshot_atomic(const std::string& rootDir,
                                         const std::vector<std::string>& replacedPaths,
                                         const std::vector<std::string>& deletedPaths);

static bool save_overlay(IndexRuntime& index,const std::string& rootDir){
  std::vector<std::string> replacedPaths,deletedPaths;
  {std::shared_lock<std::shared_mutex> lk(index.mutex);
   replacedPaths.assign(index.replacedPaths.begin(),index.replacedPaths.end());
   deletedPaths.assign(index.deletedPaths.begin(),index.deletedPaths.end());}
  bool ok=save_overlay_snapshot_atomic(rootDir,replacedPaths,deletedPaths);
  if(ok)se_log("OVERLAY_SAVED replaced="+std::to_string(replacedPaths.size())+" deleted="+std::to_string(deletedPaths.size()));
  return ok;
}

static bool save_overlay_snapshot_atomic(const std::string& rootDir,
                                         const std::vector<std::string>& replacedPaths,
                                         const std::vector<std::string>& deletedPaths){
  std::ostringstream js;js<<"{\"replaced\":[";bool first=true;
  for(const auto& value:replacedPaths){if(!first)js<<",";first=false;js<<"\""<<json_escape(value)<<"\"";}
  js<<"],\"deleted\":[";first=true;
  for(const auto& value:deletedPaths){if(!first)js<<",";first=false;js<<"\""<<json_escape(value)<<"\"";}
  js<<"]}";
  ManifestPathBoundary boundary;std::string error;
  if(!prepare_manifest_path_boundary(rootDir,true,boundary,error))return false;
  fs::path temporaryPath,finalPath;bool finalExists=false;
  if(!resolve_manifest_fixed_path(boundary,"overlay.json",false,finalPath,finalExists,error))return false;
  if(!write_fixed_manifest_temp(boundary,"overlay.tmp",js.str(),temporaryPath,error))return false;
  if(windows_env_flag_enabled("FLOATING_CLOCK_NATIVE_FAIL_OVERLAY_REPLACE_TEST")){
    DeleteFileW(temporaryPath.c_str());return false;
  }
  return atomic_replace_file(wide_to_utf8(temporaryPath.wstring()),wide_to_utf8(finalPath.wstring()));
}

static bool load_overlay(IndexRuntime& index,const std::string& rootDir,std::string* errorOut=nullptr){
  ManifestPathBoundary boundary;std::string error;fs::path overlayPath;bool exists=false;
  if(!prepare_manifest_path_boundary(rootDir,false,boundary,error)||
     !resolve_manifest_fixed_path(boundary,"overlay.json",false,overlayPath,exists,error)){
    if(errorOut)*errorOut=error;return false;
  }
  if(!exists)return true;
  std::vector<uint8_t> b;
  if(!read_file_bytes(wide_to_utf8(overlayPath.wstring()),b)){if(errorOut)*errorOut="Cannot read overlay.json";return false;}
  std::string js(b.begin(),b.end());
  std::unique_lock<std::shared_mutex> lk(index.mutex);
  // Parse "replaced" array
  size_t pos=js.find("\"replaced\":[");
  if(pos!=std::string::npos){
    pos+=12; // skip "replaced":[
    while(pos<js.size()){
      if(js[pos]=='"'){pos++;size_t end=js.find('"',pos);if(end==std::string::npos)break;
        index.replacedPaths.insert(json_unescape(js.substr(pos,end-pos)));pos=end+1;}
      else if(js[pos]==']')break;
      else pos++;
    }
  }
  // Parse "deleted" array
  pos=js.find("\"deleted\":[");
  if(pos!=std::string::npos){
    pos+=11; // skip "deleted":[
    while(pos<js.size()){
      if(js[pos]=='"'){pos++;size_t end=js.find('"',pos);if(end==std::string::npos)break;
        index.deletedPaths.insert(json_unescape(js.substr(pos,end-pos)));pos=end+1;}
      else if(js[pos]==']')break;
      else pos++;
    }
  }
  // Deleted paths must not revive in the path index map after a manifest reload
  for(const auto& np:index.deletedPaths)index.pathIndexMap.erase(make_path_key(np));
  se_log("OVERLAY_LOADED replaced="+std::to_string(index.replacedPaths.size())+" deleted="+std::to_string(index.deletedPaths.size()));
  return true;
}

static napi_value IsIndexDirty(napi_env env,napi_callback_info){
  auto& index=*get_addon_context(env).index;
  napi_value r;napi_create_object(env,&r);
  std::shared_lock<std::shared_mutex> lk(index.mutex);
  set_bool(env,r,"dirty",index.dirty.load());
  set_int64(env,r,"memoryRecords",index.mode=="memory"?(int64_t)index.records.size():(int64_t)0);
  set_int64(env,r,"overlayRecords",index.mode!="memory"?(int64_t)index.records.size():(int64_t)0);
  set_int64(env,r,"replacedCount",(int64_t)index.replacedPaths.size());
  set_int64(env,r,"deletedCount",(int64_t)index.deletedPaths.size());
  return r;
}

static napi_value SaveIndexToManifest(napi_env env,napi_callback_info info){
  try{size_t argc=1;napi_value argv[1];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
  auto& context=get_addon_context(env);auto& index=*context.index;
  std::string busyOperation;auto writeLease=try_acquire_index_writer(context.index,"save-manifest",busyOperation);
  if(!writeLease){auto error=index_writer_busy_error(busyOperation);return native_error(env,error.c_str());}
  std::string rootDir=get_string(env,argv[0]);napi_value r;napi_create_object(env,&r);
  ManifestPathBoundary boundary;std::string pathError;fs::path segDirPath,stagingDirPath,manifestPath,overlayPath;
  bool manifestExists=false,overlayExists=false;
  if(!prepare_manifest_path_boundary(rootDir,true,boundary,pathError)||
     !prepare_manifest_subdirectory(boundary,"segments",true,segDirPath,pathError)||
     !prepare_manifest_subdirectory(boundary,"staging",true,stagingDirPath,pathError)||
     !resolve_manifest_fixed_path(boundary,"manifest.json",false,manifestPath,manifestExists,pathError)||
     !resolve_manifest_fixed_path(boundary,"overlay.json",false,overlayPath,overlayExists,pathError)){
    set_bool(env,r,"ok",false);set_string(env,r,"error",pathError.c_str());return r;
  }
  rootDir=wide_to_utf8(boundary.rootPath.wstring());

  // ── Determine append vs full-save mode ──────────────
  // Append mode: we already have mmap'd segments, only write memory overlay + overlay.json
  // Full mode: first save or memory mode — write single full segment
  bool appendMode = (index.mode=="segment_mmap" && !index.segments.empty());
  std::vector<ImageRecord> overlaySnap;
  int64_t priorTotal=0;
  {std::shared_lock<std::shared_mutex> lk(index.mutex);
   if(appendMode){
     overlaySnap=index.records;
     for(auto& seg:index.segments)priorTotal+=seg->recordCount;
   }
  }

  struct SafeSavedSegment{std::shared_ptr<SegmentView> segment;std::string relativePath,resolvedPath;};
  std::vector<SafeSavedSegment> safeSavedSegments;
  if(appendMode){
    std::vector<std::shared_ptr<SegmentView>> segmentSnapshot;
    {std::shared_lock<std::shared_mutex> lk(index.mutex);segmentSnapshot=index.segments;}
    for(const auto& segment:segmentSnapshot){
      if(!segment||!segment->view)continue;SafeSavedSegment safe;safe.segment=segment;
      if(!make_manifest_segment_reference(boundary,segment->path,safe.relativePath,safe.resolvedPath,pathError)){
        set_bool(env,r,"ok",false);set_string(env,r,"error",pathError.c_str());return r;
      }
      safeSavedSegments.push_back(std::move(safe));
    }
  }

  // ── Full-save path: merge all records ───────────────
  std::vector<ImageRecord> snap;
  if(!appendMode){
    if(index.mode=="memory"){
      {std::shared_lock<std::shared_mutex> lk(index.mutex);snap=index.records;}
      priorTotal=(int64_t)snap.size();
    }else{
      for(auto& seg:index.segments){
        if(!seg->view)continue;
        for(uint64_t i=0;i<seg->recordCount;i++){
          std::string sp=std::string(seg->pathBytes+seg->pathOffsets[i]);
          std::string np=normalize_path(sp);
          if(is_path_hidden(index,np))continue;
          ImageRecord rec;rec.id=index.nextId.fetch_add(1);rec.path=sp;
          auto* meta=(const IdxMetaFwd*)seg->metadata;
          rec.width=meta[i].width;rec.height=meta[i].height;rec.channels=0;
          rec.fileSize=meta[i].fileSize;rec.modifiedTime=meta[i].modifiedTime;rec.diffHash64=seg->diffHash[i];
          rec.dctHash64=seg->dctHash?seg->dctHash[i]:0;
          snap.push_back(std::move(rec));
        }
      }
      {std::shared_lock<std::shared_mutex> lk(index.mutex);
       priorTotal=0;for(auto& seg:index.segments)priorTotal+=seg->recordCount;
       for(auto& rec:index.records)snap.push_back(rec);}
    }
    // Empty-index protection (full-save only)
    if(snap.empty()){
      std::string mfCheck=rootDir+"/manifest.json";
      std::error_code ec;
      if(fs::exists(mfCheck,ec)&&!ec){
        set_bool(env,r,"ok",false);set_string(env,r,"error","Refusing to overwrite existing manifest with empty index");return r;
      }
      set_bool(env,r,"ok",false);set_string(env,r,"error","No records to save");return r;
    }
    // 90% anomaly protection
    {int64_t effective=(int64_t)snap.size();
     if(priorTotal>0 && effective<(priorTotal*90/100) && (index.replacedPaths.empty()&&index.deletedPaths.empty())){
       std::string mfCheck=rootDir+"/manifest.json";std::error_code ec;
       if(fs::exists(mfCheck,ec)&&!ec){
         std::ostringstream err;err<<"Refusing to overwrite: effective="<<effective<<" < 90% of prior="<<priorTotal<<" (no deletions/replaces to justify drop)";
         set_bool(env,r,"ok",false);set_string(env,r,"error",err.str().c_str());return r;
       }
     }}
  }else{
    // ── Append mode: overlay-only check ────────────────
    // Allow save even if overlaySnap is empty (overlay.json may still need update for replaced/deleted)
    if(overlaySnap.empty() && index.replacedPaths.empty() && index.deletedPaths.empty()){
      // Nothing new to persist — but still update manifest timestamp for consistency
      // (skip writing new segment, just save overlay + update manifest)
    }
  }

  // Setup directories
  std::string segDir=wide_to_utf8(segDirPath.wstring()),stagingDir=wide_to_utf8(stagingDirPath.wstring());
  std::string now=now_iso();

  // ── Build manifest JSON ─────────────────────────────
  std::ostringstream mf;
  mf<<"{\"schemaVersion\":2,\"createdAt\":\""<<now<<"\",\"updatedAt\":\""<<now<<"\",\"segments\":[";
  int64_t totalRecordCount=0;uint64_t totalFileSize=0;
  bool firstSeg=true;

  if(appendMode){
    // ── Append path: keep old segments + write new overlay segment ──
    std::string newSegPath;uint64_t newCs=0,newSz=0;
    if(!overlaySnap.empty()){
      std::string segmentId=next_segment_id(index);
      std::string tmpSegPath=stagingDir+"/"+segmentId+".idx.tmp";
      newSegPath=segDir+"/"+segmentId+".idx";
      uint64_t cs=0,ts=0;
      if(!write_segment_file(overlaySnap,tmpSegPath,newSegPath,cs,ts)){
        set_bool(env,r,"ok",false);set_string(env,r,"error","Failed to write append segment");return r;
      }
      newCs=cs;newSz=ts;
      if(!firstSeg)mf<<",";firstSeg=false;
      mf<<"{\"id\":\""<<segmentId<<"\",\"file\":\"segments/"<<segmentId<<".idx\",\"recordCount\":"<<overlaySnap.size()<<",\"version\":4,\"fileSize\":"<<newSz<<",\"bodyChecksum\":\""<<hex64(newCs)<<"\",\"createdAt\":\""<<now<<"\"}";
      totalRecordCount+=overlaySnap.size();totalFileSize+=newSz;
    }
    // Include old segments in manifest
    {for(auto& saved:safeSavedSegments){
       auto& seg=saved.segment;
       if(!firstSeg)mf<<",";firstSeg=false;
       // Extract segment id from path (filename minus .idx)
       std::string sid=seg->path;
       auto slash=sid.find_last_of("/\\");if(slash!=std::string::npos)sid=sid.substr(slash+1);
       if(sid.size()>4&&sid.substr(sid.size()-4)==".idx")sid=sid.substr(0,sid.size()-4);
       const std::string& relFile=saved.relativePath;
       mf<<"{\"id\":\""<<sid<<"\",\"file\":\""<<json_escape(relFile)<<"\",\"recordCount\":"<<seg->recordCount<<",\"version\":"<<seg->version<<",\"fileSize\":"<<seg->fileSize;
       if(seg->bodyChecksum!=0)mf<<",\"bodyChecksum\":\""<<hex64(seg->bodyChecksum)<<"\"";
       mf<<"}";
       totalRecordCount+=seg->recordCount;totalFileSize+=seg->fileSize;
     }}
  }else{
    // ── Full-save path: write single full segment ──────
    std::string segmentId=next_segment_id(index);
    std::string tmpSegPath=stagingDir+"/"+segmentId+".idx.tmp";
    std::string finalSegPath=segDir+"/"+segmentId+".idx";
    uint64_t cs=0,ts=0;
    if(!write_segment_file(snap,tmpSegPath,finalSegPath,cs,ts)){
      set_bool(env,r,"ok",false);set_string(env,r,"error","Failed to write segment");return r;
    }
    mf<<"{\"id\":\""<<segmentId<<"\",\"file\":\"segments/"<<segmentId<<".idx\",\"recordCount\":"<<snap.size()<<",\"version\":4,\"fileSize\":"<<ts<<",\"bodyChecksum\":\""<<hex64(cs)<<"\",\"createdAt\":\""<<now<<"\"}";
    totalRecordCount+=snap.size();totalFileSize+=ts;
  }
  mf<<"]";
  // ── Overlay summary ─────────────────────────────────
  {std::shared_lock<std::shared_mutex> lk(index.mutex);
   mf<<",\"overlay\":{\"replacedCount\":"<<index.replacedPaths.size()<<",\"deletedCount\":"<<index.deletedPaths.size()<<"}";
  }
  mf<<"}";

  // Write manifest.tmp then atomic rename
  fs::path tmpMfPath;
  if(!write_fixed_manifest_temp(boundary,"manifest.tmp",mf.str(),tmpMfPath,pathError)||
     !atomic_replace_file(wide_to_utf8(tmpMfPath.wstring()),wide_to_utf8(manifestPath.wstring()))){
    set_bool(env,r,"ok",false);set_string(env,r,"error",pathError.empty()?"Atomic manifest replace failed":pathError.c_str());return r;
  }
  std::string finalMf=wide_to_utf8(manifestPath.wstring());

  set_bool(env,r,"ok",true);set_int64(env,r,"recordCount",totalRecordCount);set_string(env,r,"manifestPath",finalMf.c_str());
  {std::shared_lock<std::shared_mutex> lk(index.mutex);
   set_int64(env,r,"overlayRecords",(int64_t)(appendMode?overlaySnap.size():0));
   set_int64(env,r,"replacedCount",(int64_t)index.replacedPaths.size());
   set_int64(env,r,"deletedCount",(int64_t)index.deletedPaths.size());}
  index.dirty.store(false);

  // Persist sidecar files
  usn_save_state(index,rootDir);
  save_failed_paths(index,rootDir);
  if(!save_overlay(index,rootDir)){set_bool(env,r,"ok",false);set_string(env,r,"error","Atomic overlay replace failed");return r;}
  // P2: save Global Directory alongside manifest
  save_global_directory(index,rootDir);

  // ── Post-save: reload segments via mmap ─────────────
  {
    std::vector<std::string> retiredSegmentPaths;
    {std::shared_lock<std::shared_mutex> lk(index.mutex);
     for(auto& seg:index.segments){
       if(seg&&seg->view!=nullptr){
         if(appendMode){
           // Keep all old segments — none retired
         }else{
           retiredSegmentPaths.push_back(seg->path);
         }
       }
     }}
    unmap_index(index);
    {std::unique_lock<std::shared_mutex> lk(index.mutex);
     index.records.clear();index.dedupSet.clear();index.pathIndexMap.clear();
     // Preserve replaced/deleted overlay across reload
     auto savedReplaced=std::move(index.replacedPaths);
     auto savedDeleted=std::move(index.deletedPaths);
     index.replacedPaths.clear();index.deletedPaths.clear();
     // Reload only the strictly validated segment references we just committed.
     int schemaVersion=0;std::vector<std::string> segmentFiles;std::string reloadError;
     if(parse_manifest_json(mf.str(),schemaVersion,segmentFiles,reloadError)){
       for(const auto& manifestSegmentPath:segmentFiles){
         std::string segPath,relPath;
         if(!resolve_manifest_segment_path(boundary,manifestSegmentPath,segPath,relPath,reloadError,true))continue;
         auto seg=mmap_segment(index,segPath,&boundary);
         if(seg){
           seg->id=relPath.substr(relPath.find_last_of('/')+1);
           if(seg->id.size()>4&&seg->id.substr(seg->id.size()-4)==".idx")seg->id=seg->id.substr(0,seg->id.size()-4);
           index.segments.push_back(std::move(seg));
         }
       }
     }
     index.replacedPaths=std::move(savedReplaced);
     index.deletedPaths=std::move(savedDeleted);
     index.mode="segment_mmap";index.type="prefix16";index.manifestPath=rootDir;
     int64_t totalRec=0;for(auto& seg:index.segments)totalRec+=seg->recordCount;
     index.indexedCount.store(totalRec);index.failedCount.store(0);index.totalBytes.store(0);
    }
    // Clean up retired segments (full-save only)
    for(auto& retired:retiredSegmentPaths){
      std::string relativePath,resolvedPath,cleanupError;
      if(make_manifest_segment_reference(boundary,retired,relativePath,resolvedPath,cleanupError)){
        std::error_code removeEc;fs::remove(path_from_utf8(resolvedPath),removeEc);
      }
    }
    // Reload overlay from disk (restores replaced/deleted after reload)
    load_overlay(index,rootDir);
    // Reload GD
    load_global_directory(index,rootDir);
  }
  return r;
  }catch(const std::exception& e){return native_error(env,e.what());}catch(...){return native_error(env,"saveManifest error");}
}

static napi_value LoadManifest(napi_env env,napi_callback_info info){
  try{size_t argc=1;napi_value argv[1];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
  auto& context=get_addon_context(env);auto& index=*context.index;
  std::string busyOperation;auto writeLease=try_acquire_index_writer(context.index,"load-manifest",busyOperation);
  if(!writeLease){auto error=index_writer_busy_error(busyOperation);return native_error(env,error.c_str());}
  std::string rootDir=get_string(env,argv[0]);napi_value r;napi_create_object(env,&r);
  ManifestPathBoundary boundary;std::string pathError;fs::path mfPath,overlayPath;bool manifestExists=false,overlayExists=false;
  if(!prepare_manifest_path_boundary(rootDir,false,boundary,pathError)||
     !resolve_manifest_fixed_path(boundary,"manifest.json",true,mfPath,manifestExists,pathError)||
     !resolve_manifest_fixed_path(boundary,"overlay.json",false,overlayPath,overlayExists,pathError)){
    set_bool(env,r,"ok",false);set_string(env,r,"error",pathError.c_str());return r;
  }
  std::vector<uint8_t> mfBytes;
  if(!read_file_bytes(wide_to_utf8(mfPath.wstring()),mfBytes)){set_bool(env,r,"ok",false);set_string(env,r,"error","Cannot read manifest.json");return r;}
  std::string mfStr(mfBytes.begin(),mfBytes.end());

  int schemaVersion=0;std::vector<std::string> manifestSegmentFiles;std::string manifestError;
  if(!parse_manifest_json(mfStr,schemaVersion,manifestSegmentFiles,manifestError)){
    set_bool(env,r,"ok",false);set_string(env,r,"error",manifestError.c_str());return r;
  }
  if(manifestSegmentFiles.empty()){
    apply_empty_manifest(index,rootDir);
    set_bool(env,r,"ok",true);set_int64(env,r,"recordCount",0);set_int32(env,r,"segmentCount",0);return r;
  }
  std::vector<std::string> segFiles;segFiles.reserve(manifestSegmentFiles.size());
  for(const auto& manifestPath:manifestSegmentFiles){
    std::string segPath,relativePath;
    if(!resolve_manifest_segment_path(boundary,manifestPath,segPath,relativePath,pathError,true)){
      set_bool(env,r,"ok",false);set_string(env,r,"error",pathError.c_str());return r;
    }
    segFiles.push_back(std::move(segPath));
  }

  // Load all segments using mmap_segment helper
  std::vector<std::shared_ptr<SegmentView>> newSegments;
  int64_t totalRecords=0;
  for(auto& segPath:segFiles){
    auto seg=mmap_segment(index,segPath,&boundary);
    if(!seg){
      for(auto& s:newSegments){s->view=nullptr;s->fileHandle=INVALID_HANDLE_VALUE;s->mappingHandle=NULL;}
      set_bool(env,r,"ok",false);set_string(env,r,"error",("Cannot load: "+segPath).c_str());return r;
    }
    totalRecords+=seg->recordCount;
    newSegments.push_back(std::move(seg));
  }

  // All loaded — atomic swap under unique_lock
  {std::unique_lock<std::shared_mutex> lk(index.mutex);
   index.segments=std::move(newSegments);
   index.records.clear();index.dedupSet.clear();
   index.indexedCount=totalRecords;index.failedCount.store(0);index.totalBytes.store(0);
   index.mode="segment_mmap";index.type="prefix16";index.manifestPath=rootDir;}
  // Load USN state for this manifest
  usn_load_state(index,rootDir);
  load_failed_paths(index,rootDir);
  // Load overlay (replaced/deleted paths)
  if(!load_overlay(index,rootDir,&pathError)){set_bool(env,r,"ok",false);set_string(env,r,"error",pathError.c_str());return r;}
  // P2: load Global Directory if available
  load_global_directory(index,rootDir);
  set_bool(env,r,"ok",true);set_int64(env,r,"recordCount",totalRecords);set_int32(env,r,"segmentCount",(int32_t)index.segments.size());return r;
  }catch(const std::exception& e){return native_error(env,e.what());}catch(...){return native_error(env,"loadManifest error");}
}

// ===== Save single segment v4 (P4: includes DeletedBitmap) =====
static void w64s(std::ostream& f,uint64_t v){f.write((const char*)&v,8);}
static napi_value SaveIndexToSegment(napi_env env,napi_callback_info info){
  try{size_t argc=1;napi_value argv[1];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
  auto& context=get_addon_context(env);auto& index=*context.index;
  std::string busyOperation;auto writeLease=try_acquire_index_writer(context.index,"save-segment",busyOperation);
  if(!writeLease){auto error=index_writer_busy_error(busyOperation);return native_error(env,error.c_str());}
  std::string fp=get_string(env,argv[0]);napi_value r;napi_create_object(env,&r);
  std::vector<ImageRecord> snap;{std::shared_lock<std::shared_mutex> lk(index.mutex);snap=index.records;}if(snap.empty()){set_bool(env,r,"ok",false);set_string(env,r,"error","Index empty");return r;}
  uint64_t N=snap.size();
  uint64_t poOff=sizeof(IdxHeader),pbOff=poOff+(N+1)*8,metaOff=pbOff;
  for(auto& rec:snap)metaOff+=rec.path.size()+1;
  uint64_t diffHashOff=metaOff+N*sizeof(IdxMeta);
  uint64_t dctHashOff=diffHashOff+N*sizeof(uint64_t);
  uint64_t delBmpOff=dctHashOff+N*sizeof(uint64_t);
  uint64_t delBmpSz=(N+7)/8; // ceil(N/8) bytes
  uint64_t footerOff=delBmpOff+delBmpSz,totalSize=footerOff+sizeof(IdxFooter);
  std::fstream f(path_from_utf8(fp),std::ios::binary|std::ios::in|std::ios::out|std::ios::trunc);if(!f){set_bool(env,r,"ok",false);set_string(env,r,"error","Cannot open");return r;}
  IdxHeader hdr={};memcpy(hdr.magic,"IMS1",4);hdr.version=4;hdr.recordCount=N;hdr.fileSize=totalSize;hdr.headerSize=sizeof(IdxHeader);
  hdr.pathOffsetsOffset=poOff;hdr.pathBytesOffset=pbOff;hdr.metadataOffset=metaOff;hdr.diffHashOffset=diffHashOff;hdr.footerOffset=footerOff;hdr.bodyChecksum=0;
  f.write((const char*)&hdr,sizeof(IdxHeader));uint64_t bodyStart=(uint64_t)f.tellp();
  uint64_t off=0;for(auto& rec:snap){w64s(f,off);off+=rec.path.size()+1;}w64s(f,off);
  for(auto& rec:snap)f.write(rec.path.c_str(),rec.path.size()+1);
  for(auto& rec:snap){f.write((const char*)&rec.width,4);f.write((const char*)&rec.height,4);w64s(f,rec.fileSize);w64s(f,rec.modifiedTime);uint32_t z=0;f.write((const char*)&z,4);f.write((const char*)&z,4);}
  for(auto& rec:snap)w64s(f,rec.diffHash64);
  for(auto& rec:snap)w64s(f,rec.dctHash64);
  std::vector<uint8_t> delBmp(delBmpSz,0);f.write((const char*)delBmp.data(),delBmpSz); // v4: empty DeletedBitmap
  uint64_t bodyEnd=(uint64_t)f.tellp();std::vector<char> bodyBuf((size_t)(bodyEnd-bodyStart));f.seekp(bodyStart);f.read(bodyBuf.data(),bodyBuf.size());
  uint64_t cs=fnv64(bodyBuf.data(),bodyBuf.size());f.seekp(offsetof(IdxHeader,bodyChecksum));w64s(f,cs);f.seekp(0,std::ios::end);
  IdxFooter ftr={};memcpy(ftr.magic,"END\0",4);ftr.recordCount=N;ftr.version=4;f.write((const char*)&ftr,sizeof(IdxFooter));f.close();
  set_bool(env,r,"ok",true);set_int64(env,r,"recordCount",(int64_t)N);return r;
  }catch(const std::exception& e){return native_error(env,e.what());}catch(...){return native_error(env,"save error");}
}

// ===== Load single segment (backward compat) =====
static napi_value LoadIndexFromSegment(napi_env env,napi_callback_info info){
  try{size_t argc=1;napi_value argv[1];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
  auto& context=get_addon_context(env);auto& index=*context.index;
  std::string busyOperation;auto writeLease=try_acquire_index_writer(context.index,"load-segment",busyOperation);
  if(!writeLease){auto error=index_writer_busy_error(busyOperation);return native_error(env,error.c_str());}
  std::string fp=get_string(env,argv[0]);napi_value r;napi_create_object(env,&r);
  unmap_index(index);
  auto seg=mmap_segment(index,fp);
  if(!seg){set_bool(env,r,"ok",false);set_string(env,r,"error","Cannot load segment");return r;}
  int64_t n=seg->recordCount;
  index.segments.push_back(std::move(seg));
  index.mode="segment_mmap";index.type="prefix16";index.manifestPath.clear();
  {std::unique_lock<std::shared_mutex> lk(index.mutex);index.records.clear();index.dedupSet.clear();index.indexedCount=n;index.failedCount.store(0);index.totalBytes.store(0);}
  set_bool(env,r,"ok",true);set_int64(env,r,"recordCount",n);return r;
  }catch(const std::exception& e){return native_error(env,e.what());}catch(...){return native_error(env,"load error");}
}

// ===== Repair orphan segments → manifest.json =====
static napi_value RepairManifestFromSegments(napi_env env,napi_callback_info info){
  try{size_t argc=1;napi_value argv[1];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
  auto& context=get_addon_context(env);
  std::string busyOperation;auto writeLease=try_acquire_index_writer(context.index,"repair-manifest",busyOperation);
  if(!writeLease){auto error=index_writer_busy_error(busyOperation);return native_error(env,error.c_str());}
  std::string rootDir=get_string(env,argv[0]);napi_value r;napi_create_object(env,&r);
  ManifestPathBoundary boundary;std::string pathError;fs::path segDir,manifestPath;bool manifestExists=false;
  if(!prepare_manifest_path_boundary(rootDir,false,boundary,pathError)||
     !prepare_manifest_subdirectory(boundary,"segments",false,segDir,pathError)||
     !resolve_manifest_fixed_path(boundary,"manifest.json",false,manifestPath,manifestExists,pathError)){
    set_bool(env,r,"ok",false);set_string(env,r,"error",pathError.c_str());return r;
  }
  rootDir=wide_to_utf8(boundary.rootPath.wstring());std::error_code ec;
  std::ostringstream mf;
  mf<<"{\"schemaVersion\":1,\"createdAt\":\""<<now_iso()<<"\",\"updatedAt\":\""<<now_iso()<<"\",\"segments\":[";
  int segCount=0;int64_t totalRecords=0;bool firstSeg=true;
  for(auto& de:fs::directory_iterator(segDir)){
    if(!de.is_regular_file())continue;
    std::string fn=de.path().filename().string();
    if(fn.size()<4||fn.substr(fn.size()-4)!=".idx")continue;
    // Validate the segment
    std::string relativePath="segments/"+fn,segPath,normalizedRelative;
    if(!resolve_manifest_segment_path(boundary,relativePath,segPath,normalizedRelative,pathError,true)){
      set_bool(env,r,"ok",false);set_string(env,r,"error",pathError.c_str());return r;
    }
    std::wstring wfp=utf8_to_wide(segPath);
    HANDLE hFile=CreateFileW(wfp.c_str(),GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);
    if(hFile==INVALID_HANDLE_VALUE)continue;
    if(!manifest_handle_is_within_root(hFile,boundary)){CloseHandle(hFile);set_bool(env,r,"ok",false);set_string(env,r,"error","Unsafe repaired segment handle");return r;}
    LARGE_INTEGER li;GetFileSizeEx(hFile,&li);uint64_t fsz=(uint64_t)li.QuadPart;
    HANDLE hMap=CreateFileMappingW(hFile,NULL,PAGE_READONLY,0,0,NULL);
    if(!hMap){CloseHandle(hFile);continue;}
    const char* view=(const char*)MapViewOfFile(hMap,FILE_MAP_READ,0,0,0);
    if(!view){CloseHandle(hMap);CloseHandle(hFile);continue;}
    bool valid=false;uint64_t n=0,cs=0;int ver=0;
    const IdxHeader* hdr=(const IdxHeader*)view;
    if(!memcmp(hdr->magic,"IMS1",4)&&hdr->version>=1&&hdr->version<=4){
      uint64_t po=hdr->pathOffsetsOffset,mo=hdr->metadataOffset,ho=hdr->diffHashOffset;
      uint64_t metaSz=(hdr->version>=2)?sizeof(IdxMeta):24;
      uint64_t dctHo=ho+hdr->recordCount*8;
      if(!(po+(hdr->recordCount+1)*8>fsz||mo+hdr->recordCount*metaSz>fsz||ho+hdr->recordCount*8>fsz||(hdr->version>=3&&dctHo+hdr->recordCount*8>fsz))){
        const IdxFooter* ftr=(const IdxFooter*)(view+fsz-sizeof(IdxFooter));
        if(!memcmp(ftr->magic,"END\0",4)){
          if(hdr->version<2||hdr->bodyChecksum==0||fnv64(view+sizeof(IdxHeader),(size_t)(hdr->footerOffset-sizeof(IdxHeader)))==hdr->bodyChecksum){
            n=hdr->recordCount;cs=hdr->bodyChecksum;ver=hdr->version;valid=true;
          }
        }
      }
    }
    UnmapViewOfFile(view);CloseHandle(hMap);CloseHandle(hFile);
    if(!valid)continue;
    std::string segId=fn.substr(0,fn.size()-4); // strip .idx
    if(!firstSeg)mf<<",";firstSeg=false;
    mf<<"{\"id\":\""<<segId<<"\",\"file\":\"segments/"<<fn<<"\",\"recordCount\":"<<n
      <<",\"version\":"<<ver<<",\"fileSize\":"<<fsz;
    if(cs!=0)mf<<",\"bodyChecksum\":\""<<hex64(cs)<<"\"";
    mf<<"}";
    segCount++;totalRecords+=n;
  }
  mf<<"]}";
  if(segCount==0){set_bool(env,r,"ok",false);set_string(env,r,"error","No valid segments found");return r;}
  fs::path tmpMf;
  if(!write_fixed_manifest_temp(boundary,"manifest.tmp",mf.str(),tmpMf,pathError)||
     !atomic_replace_file(wide_to_utf8(tmpMf.wstring()),wide_to_utf8(manifestPath.wstring()))){
    set_bool(env,r,"ok",false);set_string(env,r,"error",pathError.empty()?"Atomic manifest replace failed":pathError.c_str());return r;
  }
  set_bool(env,r,"ok",true);set_int64(env,r,"recordCount",totalRecords);set_int32(env,r,"segmentCount",segCount);
  return r;
  }catch(const std::exception& e){return native_error(env,e.what());}catch(...){return native_error(env,"repairManifest error");}
}

// ===== Check USN availability for a path =====
static napi_value CheckUsnAvailability(napi_env env,napi_callback_info info){
  try{size_t argc=1;napi_value argv[1];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
  auto& index=*get_addon_context(env).index;
  std::string rootPath=get_string(env,argv[0]);napi_value r;napi_create_object(env,&r);
  bool isNtfs=false,canOpen=false,journalOk=false,reqAdmin=false;
  std::string volStr,reason;
  std::wstring vol;
  if(rootPath.size()>=2&&rootPath[1]==':'){
    vol+=(wchar_t)rootPath[0];vol+=L':';
    volStr=std::string(vol.begin(),vol.end());
    // Check filesystem type
    WCHAR fsName[64]={};WCHAR volName[64]={};
    std::wstring rp=vol+L"\\";
    if(GetVolumeInformationW(rp.c_str(),volName,64,NULL,NULL,NULL,fsName,64)){isNtfs=(_wcsicmp(fsName,L"NTFS")==0);}
    // Try open volume
    HANDLE hVol=usn_open_volume(vol);
    if(hVol!=INVALID_HANDLE_VALUE){canOpen=true;
      uint64_t jid=0;int64_t nusn=0;
      if(usn_query_journal(hVol,jid,nusn)){journalOk=true;}
      else{reason="journal query failed (not NTFS?)";}
      CloseHandle(hVol);
    }else{DWORD err=GetLastError();reqAdmin=(err==ERROR_ACCESS_DENIED);
      if(reqAdmin)reason="cannot open volume "+volStr+" (access denied — run as administrator)";
      else reason="cannot open volume "+volStr+" (error "+std::to_string(err)+")";
    }
  }else{reason="not a drive path";}
  set_bool(env,r,"ok",true);
  set_string(env,r,"volume",volStr.c_str());set_bool(env,r,"isNtfs",isNtfs);
  set_bool(env,r,"canOpenVolume",canOpen);set_bool(env,r,"journalOk",journalOk);
  set_bool(env,r,"requiresAdmin",reqAdmin);set_string(env,r,"reason",reason.c_str());
  // Current USN state
  {std::lock_guard<std::mutex> lk(index.usnMutex);
   set_bool(env,r,"usnStateLoaded",!index.usnStates.empty());
   int64_t lastUsn=-1;uint64_t jid=0;
   for(auto& s:index.usnStates){if(s.volPath==vol){lastUsn=s.lastUsn;jid=s.journalId;break;}}
   set_int64(env,r,"usnLastUsn",lastUsn);set_int64(env,r,"usnJournalId",(int64_t)jid);}
  return r;
  }catch(const std::exception& e){return native_error(env,e.what());}catch(...){return native_error(env,"checkUsnAvailability error");}
}

static napi_value GetIndexMode(napi_env env,napi_callback_info){
  auto& index=*get_addon_context(env).index;
  napi_value r;napi_create_object(env,&r);std::shared_lock<std::shared_mutex> lk(index.mutex);
  set_string(env,r,"mode",index.mode.c_str());set_string(env,r,"manifestPath",index.manifestPath.c_str());
  int maxVersion=2;
  for(auto& seg:index.segments){if(seg&&seg->version>maxVersion)maxVersion=seg->version;}
  set_int32(env,r,"version",maxVersion);set_int32(env,r,"segmentCount",(int32_t)index.segments.size());set_int32(env,r,"schemaVersion",2);
  int64_t totalRec=0;for(auto& seg:index.segments)totalRec+=seg->recordCount;
  if(index.mode=="memory")totalRec=(int64_t)index.records.size();
  set_int64(env,r,"recordCount",totalRec);
  set_int64(env,r,"pathIndexMapSize",(int64_t)index.pathIndexMap.size());
  set_int64(env,r,"overlayCount",index.mode!="memory"?(int64_t)index.records.size():(int64_t)0);
  set_int64(env,r,"replacedCount",(int64_t)index.replacedPaths.size());
  set_int64(env,r,"deletedCount",(int64_t)index.deletedPaths.size());
  bool healthy=totalRec>0 && (int64_t)index.pathIndexMap.size()>=totalRec*95/100;
  napi_value hv;napi_get_boolean(env,healthy,&hv);napi_set_named_property(env,r,"pathMapHealthy",hv);
  return r;
}

// ═══════════════════════════════════════════════════════════
// Async N-API helpers (P3: non-blocking load/save/hash)
// ═══════════════════════════════════════════════════════════

// Forward declaration
static void unmap_index_internal(IndexRuntime& index);

// ── Worker-safe segment loader (no global state) ──────
static std::shared_ptr<SegmentView> load_segment_worker(const std::string& segPath,
    std::vector<std::pair<PathKey,PathIndexEntry>>& outPathEntries,
    const std::shared_ptr<AsyncCancellationToken>& cancellation={},
    const std::string* excludedPrefix=nullptr,
    std::unordered_set<std::string>* outExcludedPaths=nullptr,
    const ManifestPathBoundary* boundary=nullptr){
  if(cancellation&&cancellation->isRequested())return nullptr;
  std::wstring wfp=utf8_to_wide(segPath);
  HANDLE hFile=CreateFileW(wfp.c_str(),GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);
  if(hFile==INVALID_HANDLE_VALUE)return nullptr;
  if(boundary&&!manifest_handle_is_within_root(hFile,*boundary)){CloseHandle(hFile);return nullptr;}
  LARGE_INTEGER li;GetFileSizeEx(hFile,&li);uint64_t fsz=(uint64_t)li.QuadPart;
  HANDLE hMap=CreateFileMappingW(hFile,NULL,PAGE_READONLY,0,0,NULL);
  if(!hMap){CloseHandle(hFile);return nullptr;}
  const char* view=(const char*)MapViewOfFile(hMap,FILE_MAP_READ,0,0,0);
  if(!view){CloseHandle(hMap);CloseHandle(hFile);return nullptr;}
  auto fail=[&]()->std::shared_ptr<SegmentView>{UnmapViewOfFile((LPVOID)view);CloseHandle(hMap);CloseHandle(hFile);return nullptr;};
  const IdxHeader* hdr=(const IdxHeader*)view;
  if(memcmp(hdr->magic,"IMS1",4))return fail();
  if(hdr->version<1||hdr->version>4)return fail();
  uint64_t n=hdr->recordCount,po=hdr->pathOffsetsOffset,pb=hdr->pathBytesOffset,mo=hdr->metadataOffset,ho=hdr->diffHashOffset;
  uint64_t metaSz=(hdr->version>=2)?sizeof(IdxMeta):24;
  uint64_t dctOff=ho+n*8,delOff=dctOff+n*8,delSz=(n+7)/8;
  if(po+(n+1)*8>fsz||mo+n*metaSz>fsz||ho+n*8>fsz)return fail();
  if(hdr->version>=3&&dctOff+n*8>fsz)return fail();
  if(hdr->version>=4&&delOff+delSz>fsz)return fail();
  if(!(sizeof(IdxHeader)<=po&&po<pb&&pb<mo&&mo<ho&&ho<=fsz-sizeof(IdxFooter)))return fail();
  const IdxFooter* ftr=(const IdxFooter*)(view+fsz-sizeof(IdxFooter));
  if(memcmp(ftr->magic,"END\0",4))return fail();
  if(n>0){const uint64_t* poff=(const uint64_t*)(view+po);if(poff[0]!=0)return fail();}
  if(hdr->version>=2&&hdr->bodyChecksum!=0){uint64_t bodySz=hdr->footerOffset-sizeof(IdxHeader);
    if(fnv64(view+sizeof(IdxHeader),(size_t)bodySz)!=hdr->bodyChecksum)return fail();}
  if(cancellation&&cancellation->isRequested())return fail();
  auto seg=std::make_shared<SegmentView>();seg->path=segPath;seg->version=hdr->version;seg->recordCount=n;seg->fileSize=fsz;seg->bodyChecksum=hdr->bodyChecksum;
  seg->fileHandle=hFile;seg->mappingHandle=hMap;seg->view=view;
  seg->pathOffsets=(const uint64_t*)(view+po);seg->pathBytes=view+pb;seg->metadata=(const uint8_t*)(view+mo);seg->diffHash=(const uint64_t*)(view+ho);
  seg->dctHash=(hdr->version>=3)?(const uint64_t*)(view+dctOff):nullptr;
  seg->deletedBitmap=(hdr->version>=4)?(const uint8_t*)(view+delOff):nullptr;
  seg->deletedBitmapBytes=(hdr->version>=4)?delSz:0;
  build_segment_local_index(seg);
  if(cancellation&&cancellation->isRequested())return nullptr;
  // Build path entries on the worker. An optional startup exclusion is folded
  // into this same pass so the completion callback never rescans every path.
  {const char* pbBase=view+pb;const uint64_t* poBase=(const uint64_t*)(view+po);auto* metaBase=(const IdxMetaFwd*)(view+mo);
   outPathEntries.reserve(outPathEntries.size()+n);
   for(uint64_t i=0;i<n;i++){
     if((i&255)==0&&cancellation&&cancellation->isRequested())return nullptr;
     std::string sp(pbBase+poBase[i]);std::string np=normalize_path(sp);
     if(excludedPrefix&&outExcludedPaths&&path_matches_prefix(np,*excludedPrefix)){
       outExcludedPaths->insert(std::move(np));continue;
     }
     PathIndexEntry pe;pe.fileSize=metaBase[i].fileSize;pe.modifiedTime=metaBase[i].modifiedTime;pe.fromSegment=true;
     outPathEntries.emplace_back(make_path_key(np),pe);
   }}
  return seg;
}

// ── Async: loadManifest ──────────────────────────────
struct LoadManifestAsyncData {
  std::shared_ptr<AsyncWorkRegistry> registry;
  std::shared_ptr<AsyncCancellationToken> cancellation=std::make_shared<AsyncCancellationToken>();
  std::shared_ptr<IndexRuntime> index;
  std::shared_ptr<IndexWriteLease> writeLease;
  std::string rootDir;
  std::string excludedPrefix;
  // Output
  bool ok=false,emptyManifest=false;std::string error;
  int64_t recordCount=0,excludedCount=0;int32_t segmentCount=0;
  std::vector<std::shared_ptr<SegmentView>> segments;
  std::unordered_map<PathKey,PathIndexEntry,PathKeyHash> pathIndexMap;
  std::unordered_map<std::string,std::pair<int64_t,int64_t>> failedPathMap;
  std::unordered_set<std::string> excludedPaths;
  napi_async_work work=nullptr;napi_deferred deferred=nullptr;
};

static void LoadManifestAsyncExecute(napi_env env,void* data){
  auto* d=static_cast<LoadManifestAsyncData*>(data);
  try{
    d->cancellation->markStarted();
    if(async_cancellation_checkpoint(d->cancellation,d->error))return;
    ManifestPathBoundary boundary;fs::path mfPath,overlayPath;bool manifestExists=false,overlayExists=false;
    if(!prepare_manifest_path_boundary(d->rootDir,false,boundary,d->error)||
       !resolve_manifest_fixed_path(boundary,"manifest.json",true,mfPath,manifestExists,d->error)||
       !resolve_manifest_fixed_path(boundary,"overlay.json",false,overlayPath,overlayExists,d->error))return;
    std::vector<uint8_t> mfBytes;
    if(!read_file_bytes(wide_to_utf8(mfPath.wstring()),mfBytes)){d->error="Cannot read manifest.json";return;}
    std::string mfStr(mfBytes.begin(),mfBytes.end());int schemaVersion=0;
    std::vector<std::string> manifestSegmentFiles;std::string manifestError;
    if(!parse_manifest_json(mfStr,schemaVersion,manifestSegmentFiles,manifestError)){d->error=manifestError;return;}
    if(manifestSegmentFiles.empty()){d->emptyManifest=true;d->ok=true;return;}
    std::vector<std::string> segFiles;segFiles.reserve(manifestSegmentFiles.size());
    for(const auto& manifestPath:manifestSegmentFiles){
      std::string segPath,relativePath;
      if(!resolve_manifest_segment_path(boundary,manifestPath,segPath,relativePath,d->error,true))return;
      segFiles.push_back(std::move(segPath));
    }
    for(auto& segPath:segFiles){
      if(async_cancellation_checkpoint(d->cancellation,d->error)){d->segments.clear();return;}
      std::vector<std::pair<PathKey,PathIndexEntry>> entries;
      const std::string* excludedPrefix=d->excludedPrefix.empty()?nullptr:&d->excludedPrefix;
      auto seg=load_segment_worker(segPath,entries,d->cancellation,excludedPrefix,&d->excludedPaths,&boundary);
      if(async_cancellation_checkpoint(d->cancellation,d->error)){d->segments.clear();return;}
      if(!seg){d->error="Cannot load: "+segPath;d->segments.clear();return;}
      d->segments.push_back(std::move(seg));
      d->pathIndexMap.reserve(d->pathIndexMap.size()+entries.size());
      for(auto& entry:entries)d->pathIndexMap.insert(std::move(entry));
      d->recordCount+=d->segments.back()->recordCount;
    }
    d->failedPathMap=read_failed_paths(d->rootDir);
    d->segmentCount=(int32_t)d->segments.size();
    d->excludedCount=(int64_t)d->excludedPaths.size();
    d->ok=true;
  }catch(const std::exception& e){d->error=e.what();}catch(...){d->error="loadManifest async error";}
}

static void LoadManifestAsyncComplete(napi_env env,napi_status status,void* data){
  auto* d=static_cast<LoadManifestAsyncData*>(data);
  auto& index=*d->index;
  if(status!=napi_ok||!d->ok||d->cancellation->isRequested()){
    napi_value err;napi_create_string_utf8(env,d->error.empty()?"loadManifest failed":d->error.c_str(),NAPI_AUTO_LENGTH,&err);
    napi_reject_deferred(env,d->deferred,err);
  }else if(d->emptyManifest){
    apply_empty_manifest(index,d->rootDir);
    napi_value result;napi_create_object(env,&result);
    set_bool(env,result,"ok",true);set_int64(env,result,"recordCount",0);set_int32(env,result,"segmentCount",0);
    set_int64(env,result,"removedCount",0);napi_resolve_deferred(env,d->deferred,result);
  }else{
    // Apply results to global state on main thread
    unmap_index(index);
    {std::unique_lock<std::shared_mutex> lk(index.mutex);
     index.segments=std::move(d->segments);
     index.records.clear();index.dedupSet.clear();
     index.indexedCount=d->recordCount;index.failedCount.store(0);index.totalBytes.store(0);
     index.mode="segment_mmap";index.type="prefix16";index.manifestPath=d->rootDir;
     index.pathIndexMap=std::move(d->pathIndexMap);
     index.failedPathMap=std::move(d->failedPathMap);
     index.replacedPaths.clear();
     index.deletedPaths=std::move(d->excludedPaths);
    }
    usn_load_state(index,d->rootDir);
    load_overlay(index,d->rootDir);
    load_global_directory(index,d->rootDir);
    napi_value result;napi_create_object(env,&result);
    set_bool(env,result,"ok",true);set_int64(env,result,"recordCount",d->recordCount);
    set_int32(env,result,"segmentCount",d->segmentCount);
    set_int64(env,result,"removedCount",d->excludedCount);
    napi_resolve_deferred(env,d->deferred,result);
  }
  finish_registered_async_work(env,d->registry,d->work);
  delete d;
}

static napi_value LoadManifestAsync(napi_env env,napi_callback_info info){
  size_t argc=2;napi_value argv[2];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
  if(argc<1)return reject_missing_args(env,"loadManifestAsync requires rootDir");
  auto& context=get_addon_context(env);std::string busyOperation;
  auto writeLease=try_acquire_index_writer(context.index,"load-manifest-async",busyOperation);
  if(!writeLease)return reject_index_writer_busy(env,busyOperation);
  auto* d=new LoadManifestAsyncData();
  d->registry=context.asyncWorks;d->index=context.index;d->writeLease=std::move(writeLease);
  d->rootDir=get_string(env,argv[0]);
  if(argc>=2)d->excludedPrefix=normalize_path(get_string(env,argv[1]));
  if(d->excludedPrefix.size()<4)d->excludedPrefix.clear();
  napi_value promise;napi_create_promise(env,&d->deferred,&promise);
  auto status=create_registered_async_work(env,d->registry,"fast_scanner:loadManifestAsync",
                                           LoadManifestAsyncExecute,LoadManifestAsyncComplete,d,&d->work,d->cancellation);
  if(status==napi_ok)status=queue_registered_async_work(env,d->registry,&d->work);
  if(status!=napi_ok){napi_value err;napi_create_string_utf8(env,"Failed to queue async manifest load",NAPI_AUTO_LENGTH,&err);
    napi_reject_deferred(env,d->deferred,err);delete d;}
  return promise;
}

// ── Async: saveIndexToManifest ───────────────────────
struct SaveManifestAsyncData {
  std::shared_ptr<AsyncWorkRegistry> registry;
  std::shared_ptr<AsyncCancellationToken> cancellation=std::make_shared<AsyncCancellationToken>();
  std::shared_ptr<IndexRuntime> index;
  std::shared_ptr<IndexWriteLease> writeLease;
  std::string rootDir;
  bool appendMode=false;
  bool segmentsUnchanged=false;
  std::vector<ImageRecord> overlaySnap;
  std::vector<std::string> replacedPathsSnap,deletedPathsSnap;
  // Preserved segment paths (for append mode)
  std::vector<std::string> oldSegPaths;
  size_t replacedCount=0,deletedCount=0;
  // Output
  bool ok=false;std::string error;
  int64_t recordCount=0;
  int64_t visibleRecordCount=0;
  int64_t overlayRecords=0;
  bool committed=false;
  bool safeRootPrepared=false;
  std::vector<std::string> createdSegmentPaths;
  napi_async_work work=nullptr;napi_deferred deferred=nullptr;
};

static void SaveManifestAsyncExecute(napi_env env,void* data){
  auto* d=static_cast<SaveManifestAsyncData*>(data);
  ManifestPathBoundary boundary;
  struct Rollback{SaveManifestAsyncData* data;~Rollback(){if(data->committed)return;
    std::error_code ec;if(data->safeRootPrepared){fs::remove(path_from_utf8(data->rootDir+"/manifest.tmp"),ec);
    ec.clear();fs::remove(path_from_utf8(data->rootDir+"/overlay.tmp"),ec);}
    for(auto& path:data->createdSegmentPaths){ec.clear();fs::remove(path,ec);}}}rollback{d};
  try{
    d->cancellation->markStarted();
    if(async_cancellation_checkpoint(d->cancellation,d->error))return;
    fs::path segDirPath,stagingDirPath,manifestPath,overlayPath;bool manifestExists=false,overlayExists=false;
    if(!prepare_manifest_path_boundary(d->rootDir,true,boundary,d->error)||
       !prepare_manifest_subdirectory(boundary,"segments",true,segDirPath,d->error)||
       !prepare_manifest_subdirectory(boundary,"staging",true,stagingDirPath,d->error)||
       !resolve_manifest_fixed_path(boundary,"manifest.json",false,manifestPath,manifestExists,d->error)||
       !resolve_manifest_fixed_path(boundary,"overlay.json",false,overlayPath,overlayExists,d->error))return;
    d->rootDir=wide_to_utf8(boundary.rootPath.wstring());d->safeRootPrepared=true;
    std::string segDir=wide_to_utf8(segDirPath.wstring()),stagingDir=wide_to_utf8(stagingDirPath.wstring());
    struct SafeOldSegment{std::string resolvedPath,relativePath;};std::vector<SafeOldSegment> safeOldSegments;
    if(d->appendMode){
      safeOldSegments.reserve(d->oldSegPaths.size());
      for(const auto& oldPath:d->oldSegPaths){SafeOldSegment safe;
        if(!make_manifest_segment_reference(boundary,oldPath,safe.relativePath,safe.resolvedPath,d->error))return;
        safeOldSegments.push_back(std::move(safe));}
    }
    std::string now=now_iso();
    std::ostringstream mf;
    mf<<"{\"schemaVersion\":2,\"createdAt\":\""<<now<<"\",\"updatedAt\":\""<<now<<"\",\"segments\":[";
    int64_t totalRecordCount=0;bool firstSeg=true;

    if(d->appendMode){
      if(!d->overlaySnap.empty()){
        std::string segmentId=next_segment_id(*d->index);
        std::string tmpSegPath=stagingDir+"/"+segmentId+".idx.tmp";
        std::string newSegPath=segDir+"/"+segmentId+".idx";
        uint64_t cs=0,ts=0;
        if(!write_segment_file(d->overlaySnap,tmpSegPath,newSegPath,cs,ts,d->cancellation)){
          if(!async_cancellation_checkpoint(d->cancellation,d->error))d->error="Failed to write append segment";return;}
        d->createdSegmentPaths.push_back(newSegPath);
        d->cancellation->markPreCommit();wait_at_cooperative_cancel_test_checkpoint(d->cancellation);
        if(async_cancellation_checkpoint(d->cancellation,d->error))return;
        if(!firstSeg)mf<<",";firstSeg=false;
        mf<<"{\"id\":\""<<segmentId<<"\",\"file\":\"segments/"<<segmentId<<".idx\",\"recordCount\":"<<d->overlaySnap.size()<<",\"version\":4,\"fileSize\":"<<ts<<",\"bodyChecksum\":\""<<hex64(cs)<<"\",\"createdAt\":\""<<now<<"\"}";
        totalRecordCount+=d->overlaySnap.size();
      }
      // Serialize old segment references (paths only — worker cannot read live index segments safely)
      // We rely on the snapshot of oldSegPaths taken on main thread before queuing
      for(auto& safe:safeOldSegments){
        if(async_cancellation_checkpoint(d->cancellation,d->error))return;
        const std::string& osp=safe.resolvedPath;
        if(!firstSeg)mf<<",";firstSeg=false;
        std::string sid=osp;
        auto slash=sid.find_last_of("/\\");if(slash!=std::string::npos)sid=sid.substr(slash+1);
        if(sid.size()>4&&sid.substr(sid.size()-4)==".idx")sid=sid.substr(0,sid.size()-4);
        const std::string& relFile=safe.relativePath;
        // Quick header read for recordCount (avoid full mmap on worker)
        uint64_t n=0,ver=0,cs=0;
        {std::ifstream f(path_from_utf8(osp),std::ios::binary);if(f){IdxHeader hdr;f.read((char*)&hdr,sizeof(hdr));
          if(!memcmp(hdr.magic,"IMS1",4)){n=hdr.recordCount;ver=hdr.version;cs=hdr.bodyChecksum;}}}
        if(n==0)continue;
        mf<<"{\"id\":\""<<sid<<"\",\"file\":\""<<json_escape(relFile)<<"\",\"recordCount\":"<<n<<",\"version\":"<<ver;
        if(cs!=0)mf<<",\"bodyChecksum\":\""<<hex64(cs)<<"\"";
        mf<<"}";
        totalRecordCount+=n;
      }
    }else{
      // Full-save: snap is built from overlaySnap (which holds all records in full mode)
      if(d->overlaySnap.empty()){d->error="No records to save";return;}
      std::string segmentId=next_segment_id(*d->index);
      std::string tmpSegPath=stagingDir+"/"+segmentId+".idx.tmp";
      std::string finalSegPath=segDir+"/"+segmentId+".idx";
      uint64_t cs=0,ts=0;
      if(!write_segment_file(d->overlaySnap,tmpSegPath,finalSegPath,cs,ts,d->cancellation)){
        if(!async_cancellation_checkpoint(d->cancellation,d->error))d->error="Failed to write segment";return;}
      d->createdSegmentPaths.push_back(finalSegPath);
      d->cancellation->markPreCommit();wait_at_cooperative_cancel_test_checkpoint(d->cancellation);
      if(async_cancellation_checkpoint(d->cancellation,d->error))return;
      mf<<"{\"id\":\""<<segmentId<<"\",\"file\":\"segments/"<<segmentId<<".idx\",\"recordCount\":"<<d->overlaySnap.size()<<",\"version\":4,\"fileSize\":"<<ts<<",\"bodyChecksum\":\""<<hex64(cs)<<"\",\"createdAt\":\""<<now<<"\"}";
      totalRecordCount+=d->overlaySnap.size();
    }
    mf<<"]";
    mf<<",\"overlay\":{\"replacedCount\":"<<d->replacedCount<<",\"deletedCount\":"<<d->deletedCount<<"}";
    mf<<"}";
    fs::path tmpMfPath;
    if(!write_fixed_manifest_temp(boundary,"manifest.tmp",mf.str(),tmpMfPath,d->error))return;
    if(async_cancellation_checkpoint(d->cancellation,d->error))return;
    // Overlay and manifest form one logical commit. Publish the fail-closed
    // overlay first, then the manifest that references any newly written
    // segment. A failed overlay write must never be hidden by a successful
    // manifest Promise.
    if(!save_overlay_snapshot_atomic(d->rootDir,d->replacedPathsSnap,d->deletedPathsSnap)){
      d->error="Atomic overlay replace failed";return;
    }
    if(!atomic_replace_file(wide_to_utf8(tmpMfPath.wstring()),wide_to_utf8(manifestPath.wstring()))){d->error="Atomic manifest replace failed";return;}
    d->committed=true;
    d->recordCount=totalRecordCount;
    d->ok=true;
  }catch(const std::exception& e){d->error=e.what();}catch(...){d->error="saveManifest async error";}
}

template<typename AsyncData>
static void reject_manifest_async_completion(napi_env env,AsyncData* data,const std::string& error){
  napi_value reason;napi_create_string_utf8(env,error.c_str(),NAPI_AUTO_LENGTH,&reason);
  napi_reject_deferred(env,data->deferred,reason);
  finish_registered_async_work(env,data->registry,data->work);delete data;
}

static void SaveManifestAsyncComplete(napi_env env,napi_status status,void* data){
  auto* d=static_cast<SaveManifestAsyncData*>(data);
  auto& index=*d->index;
  if(status!=napi_ok||!d->ok){
    napi_value err;napi_create_string_utf8(env,d->error.empty()?"saveManifest failed":d->error.c_str(),NAPI_AUTO_LENGTH,&err);
    napi_reject_deferred(env,d->deferred,err);
  }else if(d->segmentsUnchanged){
    // Exact deletes only change the overlay and path map. The manifest still
    // references the same mmap segments, so reloading every segment and
    // rebuilding the global directory on the main thread would be wasted O(N)
    // work and can make Electron appear hung on large indexes.
    index.dirty.store(false);
    napi_value result;napi_create_object(env,&result);
    set_bool(env,result,"ok",true);set_int64(env,result,"recordCount",d->visibleRecordCount);
    set_int64(env,result,"overlayRecords",d->overlayRecords);
    napi_resolve_deferred(env,d->deferred,result);
  }else{
    ManifestPathBoundary boundary;std::string reloadError;fs::path manifestPath;bool manifestExists=false;
    std::vector<std::string> manifestSegmentFiles,resolvedSegmentFiles;
    if(!prepare_manifest_path_boundary(d->rootDir,false,boundary,reloadError)||
       !resolve_manifest_fixed_path(boundary,"manifest.json",true,manifestPath,manifestExists,reloadError)){
      reject_manifest_async_completion(env,d,reloadError);return;
    }
    std::vector<uint8_t> manifestBytes;int schemaVersion=0;
    if(!read_file_bytes(wide_to_utf8(manifestPath.wstring()),manifestBytes)||
       !parse_manifest_json(std::string(manifestBytes.begin(),manifestBytes.end()),schemaVersion,manifestSegmentFiles,reloadError)){
      if(reloadError.empty())reloadError="Cannot reload manifest.json";
      reject_manifest_async_completion(env,d,reloadError);return;
    }
    for(const auto& manifestSegmentPath:manifestSegmentFiles){std::string resolvedPath,relativePath;
      if(!resolve_manifest_segment_path(boundary,manifestSegmentPath,resolvedPath,relativePath,reloadError,true)){
        reject_manifest_async_completion(env,d,reloadError);return;
      }
      resolvedSegmentFiles.push_back(std::move(resolvedPath));
    }
    // Reload segments on main thread
    {std::unique_lock<std::shared_mutex> lk(index.mutex);
     auto savedReplaced=std::move(index.replacedPaths);
     auto savedDeleted=std::move(index.deletedPaths);
     index.replacedPaths.clear();index.deletedPaths.clear();
     // Reload from strictly validated references in the manifest we just wrote.
     unmap_index_internal(index); // unmap without clearing overlay sets
     for(const auto& segPath:resolvedSegmentFiles){
       std::vector<std::pair<PathKey,PathIndexEntry>> entries;
       auto seg=load_segment_worker(segPath,entries,{},nullptr,nullptr,&boundary);
       if(seg){for(auto& pe:entries)index.pathIndexMap.insert(std::move(pe));index.segments.push_back(std::move(seg));}
     }
     index.replacedPaths=std::move(savedReplaced);
     index.deletedPaths=std::move(savedDeleted);
     for(const auto& deletedPath:index.deletedPaths)index.pathIndexMap.erase(make_path_key(deletedPath));
     index.mode="segment_mmap";index.type="prefix16";index.manifestPath=d->rootDir;
     index.records.clear();index.dedupSet.clear();
     int64_t totalRec=0;for(auto& seg:index.segments)totalRec+=seg->recordCount;
     index.indexedCount.store(totalRec);index.failedCount.store(0);index.totalBytes.store(0);
    }
    index.dirty.store(false);
    usn_save_state(index,d->rootDir);
    save_failed_paths(index,d->rootDir);
    save_global_directory(index,d->rootDir);
    load_global_directory(index,d->rootDir);
    napi_value result;napi_create_object(env,&result);
    set_bool(env,result,"ok",true);set_int64(env,result,"recordCount",d->recordCount);
    set_int64(env,result,"overlayRecords",d->overlayRecords);
    napi_resolve_deferred(env,d->deferred,result);
  }
  finish_registered_async_work(env,d->registry,d->work);
  delete d;
}

// Helper: unmap segments without clearing replaced/deleted sets
static void unmap_index_internal(IndexRuntime& index){
  // SegmentView owns the Win32 view, mapping handle, and file handle. Clearing
  // the shared_ptrs must run its destructor; nulling those fields first leaks
  // every handle and permanently prevents old .idx files from being removed.
  index.segments.clear();
  unmap_gd(index);
}

static napi_value SaveIndexToManifestAsync(napi_env env,napi_callback_info info){
  size_t argc=1;napi_value argv[1];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
  if(argc<1)return reject_missing_args(env,"saveIndexToManifestAsync requires rootDir");
  auto& context=get_addon_context(env);std::string busyOperation;
  auto writeLease=try_acquire_index_writer(context.index,"save-manifest-async",busyOperation);
  if(!writeLease)return reject_index_writer_busy(env,busyOperation);
  auto* d=new SaveManifestAsyncData();
  d->registry=context.asyncWorks;d->index=context.index;d->writeLease=std::move(writeLease);
  auto& index=*d->index;
  d->rootDir=get_string(env,argv[0]);
  // Snapshot state on main thread BEFORE queuing async work
  {
    bool appendMode=(index.mode=="segment_mmap"&&!index.segments.empty());
    d->appendMode=appendMode;
    std::shared_lock<std::shared_mutex> lk(index.mutex);
    if(appendMode){
      d->overlaySnap=index.records;
      for(auto& seg:index.segments){if(seg&&seg->view!=nullptr)d->oldSegPaths.push_back(seg->path);}
      d->overlayRecords=(int64_t)d->overlaySnap.size();
      d->segmentsUnchanged=d->overlaySnap.empty();
      d->visibleRecordCount=(int64_t)index.pathIndexMap.size();
    }else{
      if(index.mode=="memory"){d->overlaySnap=index.records;}
      else{
        for(auto& seg:index.segments){
          if(!seg->view)continue;
          for(uint64_t i=0;i<seg->recordCount;i++){
            std::string sp(seg->pathBytes+seg->pathOffsets[i]);
            if(is_path_hidden(index,normalize_path(sp)))continue;
            ImageRecord rec;rec.id=index.nextId.fetch_add(1);rec.path=sp;
            auto* meta=(const IdxMetaFwd*)seg->metadata;
            rec.width=meta[i].width;rec.height=meta[i].height;rec.channels=0;
            rec.fileSize=meta[i].fileSize;rec.modifiedTime=meta[i].modifiedTime;rec.diffHash64=seg->diffHash[i];
            rec.dctHash64=seg->dctHash?seg->dctHash[i]:0;
            d->overlaySnap.push_back(std::move(rec));
          }
        }
        for(auto& rec:index.records)d->overlaySnap.push_back(rec);
      }
    }
    d->replacedCount=index.replacedPaths.size();d->deletedCount=index.deletedPaths.size();
    d->replacedPathsSnap.assign(index.replacedPaths.begin(),index.replacedPaths.end());
    d->deletedPathsSnap.assign(index.deletedPaths.begin(),index.deletedPaths.end());
  }
  // Empty-index protection
  if(d->overlaySnap.empty()&&!d->appendMode){
    napi_value promise;napi_create_promise(env,&d->deferred,&promise);
    napi_value err;napi_create_string_utf8(env,"No records to save",NAPI_AUTO_LENGTH,&err);
    napi_reject_deferred(env,d->deferred,err);
    delete d;
    return promise;
  }
  if(d->appendMode&&d->oldSegPaths.empty()&&d->overlaySnap.empty()&&d->replacedCount==0&&d->deletedCount==0){
    // Nothing to persist — just update manifest timestamp in background, resolve immediately
    napi_value promise;napi_create_promise(env,&d->deferred,&promise);
    napi_value result;napi_create_object(env,&result);
    set_bool(env,result,"ok",true);set_int64(env,result,"recordCount",0);set_int64(env,result,"overlayRecords",0);
    napi_resolve_deferred(env,d->deferred,result);
    delete d;
    return promise;
  }
  napi_value promise;napi_create_promise(env,&d->deferred,&promise);
  auto status=create_registered_async_work(env,d->registry,"fast_scanner:saveIndexToManifestAsync",
                                           SaveManifestAsyncExecute,SaveManifestAsyncComplete,d,&d->work,d->cancellation);
  if(status==napi_ok)status=queue_registered_async_work(env,d->registry,&d->work);
  if(status!=napi_ok){napi_value err;napi_create_string_utf8(env,"Failed to queue async manifest save",NAPI_AUTO_LENGTH,&err);
    napi_reject_deferred(env,d->deferred,err);delete d;}
  return promise;
}

// ── Async: hashImage ─────────────────────────────────
struct HashImageAsyncData {
  std::shared_ptr<AsyncWorkRegistry> registry;
  std::string filePath;
  // Output
  bool ok=false;std::string error;
  int width=0,height=0,channels=0;
  uint64_t diffHash64=0,dctHash64=0;
  uint64_t diffHash256[4]={};
  double readMs=0,decodeMs=0,hashMs=0;
  int64_t fileSize=0;
  std::string decodeBackend;
  napi_async_work work=nullptr;napi_deferred deferred=nullptr;
};

static void HashImageAsyncExecute(napi_env env,void* data){
  auto* d=static_cast<HashImageAsyncData*>(data);
  try{
    auto t0=std::chrono::high_resolution_clock::now();
    std::vector<uint8_t> fb;
    if(!read_file_bytes(d->filePath,fb)){d->error="Cannot read file";return;}
    d->fileSize=(int64_t)fb.size();
    if((size_t)d->fileSize>MAX_QUERY_IMAGE_BYTES){d->error="Image file too large";return;}
    auto tr=std::chrono::high_resolution_clock::now();
    GrayImage gi;DecodeKind dk=DecodeKind::UNSUPPORTED;
    if(!decode_to_gray_v2(fb.data(),fb.size(),d->filePath,gi,dk)){d->error=dk==DecodeKind::UNSUPPORTED?"Unsupported image format":decode_failure_reason();return;}
    auto td=std::chrono::high_resolution_clock::now();
    d->diffHash64=compute_diffhash64(gi.gray.data(),gi.width,gi.height);
    d->dctHash64=compute_dcthash64(gi.gray.data(),gi.width,gi.height);
    compute_diffhash256(gi.gray.data(),gi.width,gi.height,d->diffHash256);
    auto th=std::chrono::high_resolution_clock::now();
    d->width=gi.sourceWidth;d->height=gi.sourceHeight;d->channels=gi.channels;
    d->readMs=std::chrono::duration<double,std::milli>(tr-t0).count();
    d->decodeMs=std::chrono::duration<double,std::milli>(td-tr).count();
    d->hashMs=std::chrono::duration<double,std::milli>(th-td).count();
    d->decodeBackend=decode_kind_name(dk);
    d->ok=true;
  }catch(const std::exception& e){d->error=e.what();}catch(...){d->error="hashImage async error";}
}

static void HashImageAsyncComplete(napi_env env,napi_status status,void* data){
  auto* d=static_cast<HashImageAsyncData*>(data);
  if(status!=napi_ok||!d->ok){
    napi_value err;napi_create_string_utf8(env,d->error.empty()?"hashImage failed":d->error.c_str(),NAPI_AUTO_LENGTH,&err);
    napi_reject_deferred(env,d->deferred,err);
  }else{
    napi_value result;napi_create_object(env,&result);
    set_bool(env,result,"ok",true);
    set_string(env,result,"diffHash64",hex64(d->diffHash64).c_str());
    set_string(env,result,"dctHash64",hex64(d->dctHash64).c_str());
    set_string(env,result,"diffHash256",hex256(d->diffHash256).c_str());
    set_int32(env,result,"width",d->width);set_int32(env,result,"height",d->height);
    set_int32(env,result,"channels",d->channels);set_double(env,result,"fileSize",(double)d->fileSize);
    set_double(env,result,"readMs",d->readMs);set_double(env,result,"decodeMs",d->decodeMs);
    set_double(env,result,"hashMs",d->hashMs);set_string(env,result,"decodeBackend",d->decodeBackend.c_str());
    napi_resolve_deferred(env,d->deferred,result);
  }
  finish_registered_async_work(env,d->registry,d->work);
  delete d;
}

static napi_value HashImageAsync(napi_env env,napi_callback_info info){
  size_t argc=1;napi_value argv[1];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
  if(argc<1)return reject_missing_args(env,"hashImageAsync requires filePath");
  auto* d=new HashImageAsyncData();
  d->registry=get_addon_context(env).asyncWorks;
  d->filePath=get_string(env,argv[0]);
  napi_value promise;napi_create_promise(env,&d->deferred,&promise);
  auto status=create_registered_async_work(env,d->registry,"fast_scanner:hashImageAsync",
                                           HashImageAsyncExecute,HashImageAsyncComplete,d,&d->work);
  if(status==napi_ok)status=queue_registered_async_work(env,d->registry,&d->work);
  if(status!=napi_ok){napi_value err;napi_create_string_utf8(env,"Failed to queue async image hash",NAPI_AUTO_LENGTH,&err);
    napi_reject_deferred(env,d->deferred,err);delete d;}
  return promise;
}

// ── Compact: merge all segments into one base segment ─
struct CompactAsyncData {
  std::shared_ptr<AsyncWorkRegistry> registry;
  std::shared_ptr<AsyncCancellationToken> cancellation=std::make_shared<AsyncCancellationToken>();
  std::shared_ptr<IndexRuntime> index;
  std::shared_ptr<IndexWriteLease> writeLease;
  std::string rootDir;
  // Output
  bool ok=false;std::string error;
  int64_t recordCount=0;int64_t beforeSegments=0;
  int64_t removedSegments=0;
  std::vector<std::string> oldSegmentPaths;
  std::vector<std::string> cleanupWarnings;
  bool committed=false;
  bool safeRootPrepared=false;
  std::string createdSegmentPath;
  napi_async_work work=nullptr;napi_deferred deferred=nullptr;
};

static void CompactAsyncExecute(napi_env env,void* data){
  auto* d=static_cast<CompactAsyncData*>(data);
  ManifestPathBoundary boundary;
  struct Rollback{CompactAsyncData* data;~Rollback(){if(data->committed)return;
    std::error_code ec;if(data->safeRootPrepared)fs::remove(path_from_utf8(data->rootDir+"/manifest.tmp"),ec);
    if(!data->createdSegmentPath.empty()){ec.clear();fs::remove(data->createdSegmentPath,ec);}}}rollback{d};
  try{
    d->cancellation->markStarted();
    if(async_cancellation_checkpoint(d->cancellation,d->error))return;
    fs::path manifestPath,overlayPath,segDirPath,stagingDirPath;bool manifestExists=false,overlayExists=false;
    if(!prepare_manifest_path_boundary(d->rootDir,false,boundary,d->error)||
       !prepare_manifest_subdirectory(boundary,"segments",false,segDirPath,d->error)||
       !prepare_manifest_subdirectory(boundary,"staging",true,stagingDirPath,d->error)||
       !resolve_manifest_fixed_path(boundary,"manifest.json",true,manifestPath,manifestExists,d->error)||
       !resolve_manifest_fixed_path(boundary,"overlay.json",false,overlayPath,overlayExists,d->error))return;
    d->rootDir=wide_to_utf8(boundary.rootPath.wstring());d->safeRootPrepared=true;
    std::vector<uint8_t> mfBytes;
    if(!read_file_bytes(wide_to_utf8(manifestPath.wstring()),mfBytes)){d->error="Cannot read manifest.json";return;}
    std::string mfStr(mfBytes.begin(),mfBytes.end());
    int schemaVersion=0;std::vector<std::string> manifestSegmentFiles,segFiles;
    if(!parse_manifest_json(mfStr,schemaVersion,manifestSegmentFiles,d->error))return;
    for(const auto& manifestSegmentPath:manifestSegmentFiles){std::string resolvedPath,relativePath;
      if(!resolve_manifest_segment_path(boundary,manifestSegmentPath,resolvedPath,relativePath,d->error,true))return;
      segFiles.push_back(std::move(resolvedPath));}
    d->beforeSegments=(int64_t)segFiles.size();

    // Merge all segment records (filter hidden paths) into one vector
    std::vector<ImageRecord> merged;
    std::unordered_set<std::string> seenPaths; // dedup by normalized path
    // Snapshot overlay sets (these are from the caller, passed via rootDir)
    // We need to read overlay.json to get replaced/deleted sets on worker thread
    std::unordered_set<std::string> replaced, deleted;
    {std::vector<uint8_t> ovBytes;
     if(overlayExists&&read_file_bytes(wide_to_utf8(overlayPath.wstring()),ovBytes)){
       std::string js(ovBytes.begin(),ovBytes.end());
       size_t p=js.find("\"replaced\":[");if(p!=std::string::npos){p+=12;
         while(p<js.size()){if(js[p]=='"'){p++;size_t e=js.find('"',p);if(e==std::string::npos)break;replaced.insert(json_unescape(js.substr(p,e-p)));p=e+1;}else if(js[p]==']')break;else p++;}}
       p=js.find("\"deleted\":[");if(p!=std::string::npos){p+=11;
         while(p<js.size()){if(js[p]=='"'){p++;size_t e=js.find('"',p);if(e==std::string::npos)break;deleted.insert(json_unescape(js.substr(p,e-p)));p=e+1;}else if(js[p]==']')break;else p++;}}
     }}

    if(segFiles.empty()){d->error="No segments to compact";return;}
    if(segFiles.size()==1&&replaced.empty()&&deleted.empty()){
      d->error="Only one segment and no overlay, nothing to compact";return;}

    int64_t nextId=1;
    for(auto& segPath:segFiles){
      if(async_cancellation_checkpoint(d->cancellation,d->error))return;
      std::vector<std::pair<PathKey,PathIndexEntry>> entries;
      auto seg=load_segment_worker(segPath,entries,d->cancellation,nullptr,nullptr,&boundary);
      if(async_cancellation_checkpoint(d->cancellation,d->error))return;
      if(!seg){d->error="Cannot load segment: "+segPath;return;}
      const char* pb=seg->pathBytes;
      const uint64_t* po=seg->pathOffsets;
      auto* meta=(const IdxMetaFwd*)seg->metadata;
      for(uint64_t i=0;i<seg->recordCount;i++){
        if((i&255)==0&&async_cancellation_checkpoint(d->cancellation,d->error))return;
        std::string sp(pb+po[i]);std::string np=normalize_path(sp);
        // Manifest order is newest first, so dedup retains the effective replacement.
        if(deleted.count(np))continue;
        if(seenPaths.count(np))continue;
        seenPaths.insert(np);
        ImageRecord rec;rec.id=nextId++;rec.path=sp;
        rec.width=meta[i].width;rec.height=meta[i].height;rec.channels=0;
        rec.fileSize=meta[i].fileSize;rec.modifiedTime=meta[i].modifiedTime;
        rec.diffHash64=seg->diffHash[i];
        rec.dctHash64=seg->dctHash?seg->dctHash[i]:0;
        merged.push_back(std::move(rec));
      }
    }
    if(merged.empty()){d->error="No records after merge";return;}

    // Write merged segment
    std::string segDir=wide_to_utf8(segDirPath.wstring()),stagingDir=wide_to_utf8(stagingDirPath.wstring());
    std::string segmentId=next_segment_id(*d->index);
    std::string tmpSegPath=stagingDir+"/"+segmentId+".idx.tmp";
    std::string finalSegPath=segDir+"/"+segmentId+".idx";
    uint64_t cs=0,ts=0;
    if(!write_segment_file(merged,tmpSegPath,finalSegPath,cs,ts,d->cancellation)){
      if(!async_cancellation_checkpoint(d->cancellation,d->error))d->error="Failed to write merged segment";return;}
    d->createdSegmentPath=finalSegPath;
    if(async_cancellation_checkpoint(d->cancellation,d->error))return;

    // Write new manifest (single segment)
    std::string now=now_iso();
    std::ostringstream mf;
    mf<<"{\"schemaVersion\":2,\"createdAt\":\""<<now<<"\",\"updatedAt\":\""<<now<<"\",\"segments\":[";
    mf<<"{\"id\":\""<<segmentId<<"\",\"file\":\"segments/"<<segmentId<<".idx\",\"recordCount\":"<<merged.size()<<",\"version\":4,\"fileSize\":"<<ts<<",\"bodyChecksum\":\""<<hex64(cs)<<"\",\"createdAt\":\""<<now<<"\"}";
    mf<<"],\"overlay\":{\"replacedCount\":0,\"deletedCount\":0}}";
    fs::path tmpMf;
    if(!write_fixed_manifest_temp(boundary,"manifest.tmp",mf.str(),tmpMf,d->error))return;
    if(async_cancellation_checkpoint(d->cancellation,d->error))return;
    if(!atomic_replace_file(wide_to_utf8(tmpMf.wstring()),wide_to_utf8(manifestPath.wstring()))){d->error="Atomic manifest replace failed";return;}
    d->committed=true;
    d->oldSegmentPaths=segFiles;

    // Delete old overlay (compacted away)
    if(overlayExists){std::error_code ec;fs::remove(overlayPath,ec);}

    d->recordCount=(int64_t)merged.size();
    d->ok=true;
  }catch(const std::exception& e){d->error=e.what();}catch(...){d->error="compact async error";}
}

static void CompactAsyncComplete(napi_env env,napi_status status,void* data){
  auto* d=static_cast<CompactAsyncData*>(data);
  auto& index=*d->index;
  if(status!=napi_ok||!d->ok){
    napi_value err;napi_create_string_utf8(env,d->error.empty()?"compact failed":d->error.c_str(),NAPI_AUTO_LENGTH,&err);
    napi_reject_deferred(env,d->deferred,err);
  }else{
    ManifestPathBoundary boundary;std::string pathError;fs::path segmentsPath,manifestPath;bool manifestExists=false;
    std::vector<std::string> safeOldSegmentPaths,manifestSegmentFiles,reloadSegmentPaths;
    if(!prepare_manifest_path_boundary(d->rootDir,false,boundary,pathError)||
       !prepare_manifest_subdirectory(boundary,"segments",false,segmentsPath,pathError)||
       !resolve_manifest_fixed_path(boundary,"manifest.json",true,manifestPath,manifestExists,pathError)){
      reject_manifest_async_completion(env,d,pathError);return;
    }
    for(const auto& oldPath:d->oldSegmentPaths){std::string relativePath,resolvedPath;
      if(!make_manifest_segment_reference(boundary,oldPath,relativePath,resolvedPath,pathError)){
        reject_manifest_async_completion(env,d,pathError);return;
      }
      safeOldSegmentPaths.push_back(std::move(resolvedPath));
    }
    std::vector<uint8_t> manifestBytes;int schemaVersion=0;
    if(!read_file_bytes(wide_to_utf8(manifestPath.wstring()),manifestBytes)||
       !parse_manifest_json(std::string(manifestBytes.begin(),manifestBytes.end()),schemaVersion,manifestSegmentFiles,pathError)){
      if(pathError.empty())pathError="Cannot reload compacted manifest";
      reject_manifest_async_completion(env,d,pathError);return;
    }
    for(const auto& manifestSegmentPath:manifestSegmentFiles){std::string resolvedPath,relativePath;
      if(!resolve_manifest_segment_path(boundary,manifestSegmentPath,resolvedPath,relativePath,pathError,true)){
        reject_manifest_async_completion(env,d,pathError);return;
      }
      reloadSegmentPaths.push_back(std::move(resolvedPath));
    }
    // Release the old mmap views before deleting their segment files. Windows
    // rejects removal while a view is mapped, which otherwise leaves physical
    // tombstone residue even though the new manifest is already authoritative.
    unmap_index(index);
    for(auto& oldPath:safeOldSegmentPaths){
      if(normalize_path(oldPath)==normalize_path(d->createdSegmentPath))continue;
      std::error_code ec;
      bool removed=fs::remove(oldPath,ec);
      if(removed)d->removedSegments++;
      else if(ec)d->cleanupWarnings.push_back(oldPath+": "+ec.message());
    }
    // Reload segments on main thread
    {std::unique_lock<std::shared_mutex> lk(index.mutex);
     index.records.clear();index.dedupSet.clear();index.pathIndexMap.clear();
     index.replacedPaths.clear();index.deletedPaths.clear();
     for(const auto& segPath:reloadSegmentPaths){
       std::vector<std::pair<PathKey,PathIndexEntry>> entries;
       auto seg=load_segment_worker(segPath,entries,{},nullptr,nullptr,&boundary);
       if(seg){for(auto& pe:entries)index.pathIndexMap.insert(std::move(pe));index.segments.push_back(std::move(seg));}
     }
     index.mode="segment_mmap";index.type="prefix16";index.manifestPath=d->rootDir;
     int64_t totalRec=0;for(auto& seg:index.segments)totalRec+=seg->recordCount;
     index.indexedCount.store(totalRec);index.failedCount.store(0);index.totalBytes.store(0);
    }
    index.dirty.store(false);
    usn_save_state(index,d->rootDir);
    save_global_directory(index,d->rootDir);
    napi_value result;napi_create_object(env,&result);
    set_bool(env,result,"ok",true);set_int64(env,result,"recordCount",d->recordCount);
    set_int64(env,result,"beforeSegments",d->beforeSegments);
    set_int64(env,result,"removedSegments",d->removedSegments);
    set_bool(env,result,"physicalCleanupComplete",d->cleanupWarnings.empty());
    if(!d->cleanupWarnings.empty())set_string(env,result,"cleanupError",d->cleanupWarnings.front().c_str());
    napi_resolve_deferred(env,d->deferred,result);
  }
  finish_registered_async_work(env,d->registry,d->work);
  delete d;
}

static napi_value CompactManifestAsync(napi_env env,napi_callback_info info){
  size_t argc=1;napi_value argv[1];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
  if(argc<1)return reject_missing_args(env,"compactManifestAsync requires rootDir");
  auto& context=get_addon_context(env);std::string busyOperation;
  auto writeLease=try_acquire_index_writer(context.index,"compact-manifest-async",busyOperation);
  if(!writeLease)return reject_index_writer_busy(env,busyOperation);
  auto* d=new CompactAsyncData();
  d->registry=context.asyncWorks;d->index=context.index;d->writeLease=std::move(writeLease);
  d->rootDir=get_string(env,argv[0]);
  napi_value promise;napi_create_promise(env,&d->deferred,&promise);
  auto status=create_registered_async_work(env,d->registry,"fast_scanner:compactManifestAsync",
                                           CompactAsyncExecute,CompactAsyncComplete,d,&d->work,d->cancellation);
  if(status==napi_ok)status=queue_registered_async_work(env,d->registry,&d->work);
  if(status!=napi_ok){napi_value err;napi_create_string_utf8(env,"Failed to queue async manifest compact",NAPI_AUTO_LENGTH,&err);
    napi_reject_deferred(env,d->deferred,err);delete d;}
  return promise;
}

// ── Sync: check compact recommendation ────────────────
static napi_value GetCompactStatus(napi_env env,napi_callback_info){
  auto& index=*get_addon_context(env).index;
  napi_value r;napi_create_object(env,&r);
  std::shared_lock<std::shared_mutex> lk(index.mutex);
  int32_t segCount=(int32_t)index.segments.size();
  set_int32(env,r,"segmentCount",segCount);
  set_bool(env,r,"compactRecommended",segCount>3);
  set_bool(env,r,"ok",true);
  return r;
}

// ── Async: searchByImage (decode off main thread) ─────
struct SearchByImageAsyncData {
  std::shared_ptr<AsyncWorkRegistry> registry;
  std::string filePath;int threshold=10,topK=20;std::string searchMode;
  std::shared_ptr<IndexRuntime> index;
  // Output
  bool ok=false;std::string error;
  std::vector<SearchHit> hits;SearchMetrics metrics{};
  uint64_t queryHash=0,queryDctHash=0;
  double searchMs=0;
  napi_async_work work=nullptr;napi_deferred deferred=nullptr;
};

static void SearchByImageAsyncExecute(napi_env env,void* data){
  auto* d=static_cast<SearchByImageAsyncData*>(data);
  try{
    std::vector<uint8_t> fb;
    if(!read_file_bytes(d->filePath,fb)){d->error="Cannot read query";return;}
    if(fb.size()>MAX_QUERY_IMAGE_BYTES){d->error="Image file too large";return;}
    HashResultV1 qhr;
    if(!decode_and_hash_dual(fb.data(),fb.size(),qhr,d->filePath)){
      d->error=qhr.decodeKind==DecodeKind::UNSUPPORTED?"Unsupported image format":decode_failure_reason();return;
    }
    d->queryHash=qhr.diffHash64;d->queryDctHash=qhr.dctHash64;
    auto t0=std::chrono::high_resolution_clock::now();
    // Search must happen on the main thread — defer to Complete.
    // Store params for Complete to use
    auto t1=std::chrono::high_resolution_clock::now();
    d->searchMs=std::chrono::duration<double,std::milli>(t1-t0).count();
    d->ok=true;
  }catch(const std::exception& e){d->error=e.what();}catch(...){d->error="searchByImage async error";}
}

static void SearchByImageAsyncComplete(napi_env env,napi_status status,void* data){
  auto* d=static_cast<SearchByImageAsyncData*>(data);
  if(status!=napi_ok||!d->ok){
    napi_value err;napi_create_string_utf8(env,d->error.empty()?"searchByImage failed":d->error.c_str(),NAPI_AUTO_LENGTH,&err);
    napi_reject_deferred(env,d->deferred,err);
  }else{
    auto& index=*d->index;
    // Run search on main thread against the context-provided index.
    auto t0=std::chrono::high_resolution_clock::now();
    std::string sm=d->searchMode;
    bool dctMode=(sm=="dct");
    if(sm=="recall")search_linear_by_hash(index,d->queryHash,d->threshold,d->topK,d->hits,d->metrics,d->queryDctHash,false);
    else if(sm=="balanced")search_balanced_by_hash(index,d->queryHash,d->threshold,d->topK,d->hits,d->metrics,d->queryDctHash,false);
    else if(sm=="dct")search_linear_by_hash(index,d->queryHash,d->threshold,d->topK,d->hits,d->metrics,d->queryDctHash,true);
    else search_by_hash(index,d->queryHash,d->threshold,d->topK,d->hits,d->metrics,d->queryDctHash,false);
    auto t1=std::chrono::high_resolution_clock::now();
    d->searchMs+=std::chrono::duration<double,std::milli>(t1-t0).count();

    napi_value result;napi_create_object(env,&result);
    set_bool(env,result,"ok",true);
    set_string(env,result,"queryHash",hex64(d->queryHash).c_str());
    set_string(env,result,"queryDctHash64",hex64(d->queryDctHash).c_str());
    set_int64(env,result,"scannedCount",(int64_t)d->metrics.scanned);
    set_int64(env,result,"candidateCount",(int64_t)d->metrics.candidates);
    set_double(env,result,"searchMs",d->searchMs);
    set_string(env,result,"mode",index.mode.c_str());
    set_string(env,result,"indexType",dctMode?"linear-dct":(d->metrics.indexType?d->metrics.indexType:"linear"));
    set_int64(env,result,"bucketSize",(int64_t)d->metrics.bucketSize);
    set_int32(env,result,"segmentCount",(int32_t)index.segments.size());
    set_int32(env,result,"searchedSegments",d->metrics.searchedSegments);
    napi_value fbv;napi_get_boolean(env,d->metrics.fallbackUsed,&fbv);napi_set_named_property(env,result,"fallbackUsed",fbv);
    napi_value arr;napi_create_array_with_length(env,d->hits.size(),&arr);
    for(size_t i=0;i<d->hits.size();i++){
      napi_value o;napi_create_object(env,&o);
      set_int64(env,o,"id",d->hits[i].id);set_string(env,o,"path",d->hits[i].path.c_str());
      set_double(env,o,"score",d->hits[i].score);set_int32(env,o,"distance",d->hits[i].distance);
      set_int32(env,o,"dctDistance",d->hits[i].dctDistance);
      set_int32(env,o,"width",d->hits[i].width);set_int32(env,o,"height",d->hits[i].height);
      set_int64(env,o,"fileSize",d->hits[i].fileSize);
      set_string(env,o,"diffHash64",hex64(d->hits[i].diffHash64).c_str());
      if(d->hits[i].dctHash64!=0)set_string(env,o,"dctHash64",hex64(d->hits[i].dctHash64).c_str());
      napi_set_element(env,arr,i,o);
    }
    napi_set_named_property(env,result,"results",arr);
    set_int32(env,result,"resultCount",(int32_t)d->hits.size());
    napi_resolve_deferred(env,d->deferred,result);
  }
  finish_registered_async_work(env,d->registry,d->work);
  delete d;
}

static napi_value SearchByImageAsync(napi_env env,napi_callback_info info){
  size_t argc=4;napi_value argv[4];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
  if(argc<2)return reject_missing_args(env,"searchByImageAsync requires filePath and threshold");
  auto* d=new SearchByImageAsyncData();
  auto& context=get_addon_context(env);
  d->registry=context.asyncWorks;d->index=context.index;
  d->filePath=get_string(env,argv[0]);
  d->threshold=std::clamp(get_int32(env,argv[1]),0,64);
  // Match the sync searchByImage default: a missing/non-positive topK must not reach
  // the candidate heap as 0 — heap.top() on an empty heap crashes once a hit exists.
  // FS-07Q: clamp to the same 1..1000 bound as the sync entries.
  int topKArg=argc>=3?get_int32(env,argv[2]):0;
  d->topK=topKArg>0?std::min(topKArg,1000):20;
  d->searchMode=argc>=4?get_string(env,argv[3]):"balanced";
  napi_value promise;napi_create_promise(env,&d->deferred,&promise);
  auto status=create_registered_async_work(env,d->registry,"fast_scanner:searchByImageAsync",
                                           SearchByImageAsyncExecute,SearchByImageAsyncComplete,d,&d->work);
  if(status==napi_ok)status=queue_registered_async_work(env,d->registry,&d->work);
  if(status!=napi_ok){napi_value err;napi_create_string_utf8(env,"Failed to queue async image search",NAPI_AUTO_LENGTH,&err);
    napi_reject_deferred(env,d->deferred,err);delete d;}
  return promise;
}

// File-manager moves must not be implemented as link + unlink: an editor may
// atomically replace the source between those calls, losing its newest save.
// flags=0 gives one no-replace OS rename and reports cross-volume moves instead
// of silently degrading to CopyFile/DeleteFile.
struct MovePathNoReplaceData {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::shared_ptr<AsyncWorkRegistry> registry;
  std::wstring source, destination;
  DWORD error = ERROR_SUCCESS;
};

static const char* move_path_error_code(DWORD error) {
  switch (error) {
    case ERROR_FILE_EXISTS: case ERROR_ALREADY_EXISTS: return "EEXIST";
    case ERROR_NOT_SAME_DEVICE: return "EXDEV";
    case ERROR_FILE_NOT_FOUND: case ERROR_PATH_NOT_FOUND: return "ENOENT";
    case ERROR_ACCESS_DENIED: case ERROR_WRITE_PROTECT: return "EACCES";
    case ERROR_SHARING_VIOLATION: case ERROR_LOCK_VIOLATION: return "EBUSY";
    case ERROR_INVALID_NAME: case ERROR_INVALID_PARAMETER: return "EINVAL";
    case ERROR_FILENAME_EXCED_RANGE: return "ENAMETOOLONG";
    case ERROR_OPERATION_ABORTED: return "ECANCELED";
    default: return "EIO";
  }
}

static napi_value move_path_error(napi_env env, DWORD error) {
  const char* code = move_path_error_code(error);
  std::string message = std::string("Atomic move failed (") + code +
    ", Windows error " + std::to_string(error) + ")";
  napi_value text, result;
  napi_create_string_utf8(env, message.c_str(), NAPI_AUTO_LENGTH, &text);
  napi_create_error(env, nullptr, text, &result);
  set_string(env, result, "code", code);
  set_int32(env, result, "win32Code", static_cast<int32_t>(error));
  return result;
}

static void MovePathNoReplaceExecute(napi_env, void* data) {
  auto* operation = static_cast<MovePathNoReplaceData*>(data);
  if (!MoveFileExW(operation->source.c_str(), operation->destination.c_str(), 0)) {
    operation->error = GetLastError();
  }
}

static void MovePathNoReplaceComplete(napi_env env, napi_status status, void* data) {
  auto* operation = static_cast<MovePathNoReplaceData*>(data);
  if (status != napi_ok && operation->error == ERROR_SUCCESS) {
    operation->error = ERROR_OPERATION_ABORTED;
  }
  if (operation->error != ERROR_SUCCESS) {
    napi_reject_deferred(env, operation->deferred, move_path_error(env, operation->error));
  } else {
    napi_value result; napi_get_undefined(env, &result);
    napi_resolve_deferred(env, operation->deferred, result);
  }
  finish_registered_async_work(env, operation->registry, operation->work);
  delete operation;
}

static bool read_move_path(napi_env env, napi_value argument, std::wstring& output) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, argument, nullptr, 0, &length) != napi_ok ||
      length == 0 || length > 32767) return false;
  std::vector<char16_t> buffer(length + 1);
  if (napi_get_value_string_utf16(env, argument, buffer.data(), buffer.size(), &length) != napi_ok) {
    return false;
  }
  for (size_t index = 0; index < length; ++index) {
    if (buffer[index] == 0) return false;
  }
  output.assign(buffer.begin(), buffer.begin() + length);
  return true;
}

static napi_value MovePathWithoutOverwriteAsync(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto* operation = new MovePathNoReplaceData();
  if (argc != 2 || !read_move_path(env, argv[0], operation->source) ||
      !read_move_path(env, argv[1], operation->destination)) {
    delete operation;
    napi_throw_type_error(env, "EINVAL", "Atomic move requires two non-empty paths without NUL");
    return nullptr;
  }
  operation->registry = get_addon_context(env).asyncWorks;
  napi_value promise; napi_create_promise(env, &operation->deferred, &promise);
  auto status = create_registered_async_work(env, operation->registry, "fast_scanner:atomicMove",
    MovePathNoReplaceExecute, MovePathNoReplaceComplete, operation, &operation->work);
  if (status == napi_ok) status = queue_registered_async_work(env, operation->registry, &operation->work);
  if (status != napi_ok) {
    napi_reject_deferred(env, operation->deferred, move_path_error(env, ERROR_OPERATION_ABORTED));
    delete operation;
  }
  return promise;
}

static napi_value RunNativeLogTest(napi_env env,napi_callback_info info){
  const char* enabled=getenv("FLOATING_CLOCK_NATIVE_LOG_TEST");
  if(enabled==nullptr||std::string(enabled)!="1")return native_error(env,"native log test mode disabled");
  size_t argc=3;napi_value argv[3];napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
  if(argc<3)return native_error(env,"runNativeLogTest requires path, threads, writes");
  const std::string samplePath=get_string(env,argv[0]);
  const int threads=std::clamp(get_int32(env,argv[1]),1,16);
  const int writes=std::clamp(get_int32(env,argv[2]),1,10000);
  std::vector<std::thread> workers;workers.reserve((size_t)threads);
  se_log("TEST_RAW "+samplePath);
  for(int threadIndex=0;threadIndex<threads;threadIndex++){
    workers.emplace_back([samplePath,writes,threadIndex](){
      for(int index=0;index<writes;index++){
        se_log("TEST_WRITE worker="+std::to_string(threadIndex)+" index="+std::to_string(index)+" path="+se_path(samplePath));
      }
    });
  }
  for(auto& worker:workers)worker.join();
  const auto policy=rotating_logger::policy();
  napi_value result;napi_create_object(env,&result);set_bool(env,result,"ok",true);
  set_string(env,result,"logPath",policy.log_path.c_str());
  set_double(env,result,"maxBytes",(double)policy.max_bytes);
  set_int32(env,result,"backupCount",policy.backup_count);
  set_bool(env,result,"verbosePaths",policy.verbose_paths);
  return result;
}

static void cleanup_addon_async_work(napi_async_cleanup_hook_handle cleanupHook,void* data){
  auto* context=static_cast<AddonContext*>(data);
  if(context)context->asyncWorks->beginTeardown(cleanupHook);
}

static void finalize_addon_context(napi_env,void* data,void*){
  auto* context=static_cast<AddonContext*>(data);
  if(!context)return;
  try{
    request_scan_stop(*context->scan);
    stop_scan_sync(*context->scan);
  }catch(...){crash_log("FastScanner scan context cleanup failed");}
  auto& index=*context->index;
  if(index.attachedEnvs.fetch_sub(1)==1){
    try{
      thumbnail_rebuilder::shutdown();
      thumbnail_sidecar::finish_scan();
    }catch(...){crash_log("FastScanner shared context cleanup failed");}
  }
  se_log("CLEANUP fast_scanner shutdown complete");
  delete context;
}

// ===== Init =====
static napi_value Init(napi_env env,napi_value exports){
  auto* context=new AddonContext(env,acquire_shared_index_runtime());
  if(napi_add_async_cleanup_hook(env,cleanup_addon_async_work,context,&context->asyncCleanupHook)!=napi_ok){
    delete context;napi_throw_error(env,nullptr,"Failed to initialize FastScanner async cleanup");return nullptr;
  }
  if(napi_set_instance_data(env,context,finalize_addon_context,nullptr)!=napi_ok){
    napi_remove_async_cleanup_hook(context->asyncCleanupHook);
    delete context;napi_throw_error(env,nullptr,"Failed to initialize FastScanner addon context");return nullptr;
  }
  context->index->attachedEnvs.fetch_add(1);
  napi_value fn;auto xfn=[&](const char* js,napi_callback cf){napi_create_function(env,nullptr,0,cf,nullptr,&fn);napi_set_named_property(env,exports,js,fn);};
  xfn("getNativeVersion",GetNativeVersion);xfn("getNativeStatus",GetNativeStatus);xfn("hashImage",HashImage);
  xfn("movePathWithoutOverwriteAsync",MovePathWithoutOverwriteAsync);
  xfn("configureScanThumbnails",ConfigureScanThumbnails);
  xfn("configureScanCommitFeed",ConfigureScanCommitFeed);
  xfn("drainScanCommittedPaths",DrainScanCommittedPaths);
  xfn("startNativeThumbnailRebuild",StartNativeThumbnailRebuild);
  xfn("getNativeThumbnailRebuildProgress",GetNativeThumbnailRebuildProgress);
  xfn("stopNativeThumbnailRebuild",StopNativeThumbnailRebuild);
  xfn("scanDirectory",ScanDirectory);xfn("getScanProgress",GetScanProgress);xfn("stopScan",StopScan);xfn("stopScanAsync",StopScanAsync);
  xfn("stopScanGenerationAsync",StopScanGenerationAsync);
  xfn("snapshotScanRecordsAsync",SnapshotScanRecordsAsync);xfn("readScanExportPage",ReadScanExportPage);
  xfn("pauseScan",PauseScan);xfn("resumeScan",ResumeScan);xfn("isScanPaused",IsScanPaused);
  xfn("getIndexStats",GetIndexStats);xfn("clearIndex",ClearIndex);xfn("searchByHash",SearchByHash);
  xfn("queryIndexRecords",QueryIndexRecords);xfn("snapshotIndexRecords",SnapshotIndexRecords);xfn("snapshotIndexRecordsAsync",SnapshotIndexRecordsAsync);xfn("readIndexExportPage",ReadIndexExportPage);xfn("closeIndexExport",CloseIndexExport);xfn("deleteIndexPathsPagedAsync",DeleteIndexPathsPagedAsync);xfn("hasIndexPath",HasIndexPath);xfn("deleteIndexPath",DeleteIndexPath);xfn("deleteIndexPaths",DeleteIndexPaths);xfn("deleteIndexPathsAsync",DeleteIndexPathsAsync);
  xfn("purgeIndexPathPrefix",PurgeIndexPathPrefix);xfn("getIndexPathStats",GetIndexPathStats);
  xfn("getIndexPathSegmentStats",GetIndexPathSegmentStats);xfn("purgeIndexPathSegment",PurgeIndexPathSegment);
  xfn("repairIndexPath",RepairIndexPath);xfn("upsertIndexRecord",UpsertIndexRecord);
  xfn("searchByImage",SearchByImage);xfn("saveIndexToSegment",SaveIndexToSegment);
  xfn("loadIndexFromSegment",LoadIndexFromSegment);xfn("getIndexMode",GetIndexMode);
  xfn("saveIndexToManifest",SaveIndexToManifest);xfn("loadManifest",LoadManifest);
  xfn("isIndexDirty",IsIndexDirty);xfn("repairManifestFromSegments",RepairManifestFromSegments);
  xfn("checkUsnAvailability",CheckUsnAvailability);
  // Async (Promise-based) variants
  xfn("loadManifestAsync",LoadManifestAsync);
  xfn("saveIndexToManifestAsync",SaveIndexToManifestAsync);
  xfn("hashImageAsync",HashImageAsync);
  xfn("compactManifestAsync",CompactManifestAsync);
  xfn("searchByImageAsync",SearchByImageAsync);
  xfn("cancelAsyncWork",CancelAsyncWork);
  xfn("getCompactStatus",GetCompactStatus);
  xfn("runNativeLogTest",RunNativeLogTest);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,Init)
