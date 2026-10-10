# Third-Party Notices

This document records third-party models, runtimes, tools and UI assets used by Siftory（寻藏）.
The selected distribution uses the **Online** profile. Model weights are obtained separately
by users and are not part of this installer. It excludes the Gyan FFmpeg/FFprobe command-line
tools, YOLO weights, CUDA/cuDNN, Ollama and llama.cpp; the project native addon and Source Han Sans UI font are
marked as bundled components. The separate **Offline** profile is an internal candidate and adds only the
three pinned embedding-model directories and the pinned FFmpeg files selected by the profile
allowlist. Neither profile may be commercially released while its license gate is pending.
Electron's own `ffmpeg.dll` remains present in Online and is a separate LGPL component;
excluding the Gyan command-line tools does not exclude this library.

The packaged `runtime-manifest.json` and generated `THIRD_PARTY_COMPONENTS.md` identify the
recorded runtime candidates, versions and selected profile's bundling status; they are not a
complete recursive inventory of Electron, bundled JavaScript or native libraries. `NODE_THIRD_PARTY_COMPONENTS.md`
records non-development npm dependencies from the lockfile, while the release SBOM and final
unpacked-package scan identify the exact shipped artifact.
The packaged `LICENSE_DECISIONS.json` file records approvals separately; pending entries
are intentionally release-blocking when applicable to the selected distribution and must not be
interpreted as permission. A non-bundled model entry does not require purchasing redistribution
rights for an installer that does not contain it; its actual use and integration are reviewed separately.

This notice and the generated inventory are engineering provenance records, not legal
approval. Components marked `legal-review-required` or `project-license-pending` remain
blocked from public or commercial distribution until an authorized reviewer records a
decision and all required license texts and source-offer obligations are satisfied.

---

## Source Han Sans CN Variable (bundled UI font)

- **Name**: Source Han Sans CN Variable, Simplified Chinese region-specific subset
- **Upstream**: Adobe Source Han Sans 2.005R release branch
- **Source**: https://github.com/adobe-fonts/source-han-sans
- **License**: SIL Open Font License 1.1 (`OFL-1.1`)
- **Bundled artifact**: `SourceHanSansCN-VF.otf.woff2`
- **SHA-256**: `7087698d52240614659957608d8c4ad446759aee3208409dc9f566412e7af8f4`
- **License text**: `legal/SourceHanSans-OFL-1.1.txt`
- **Use**: Application interface typography; terminal output, paths and hashes retain a monospace stack.

The upstream font is redistributed unmodified with the application. The OFL permits bundling and
selling the font with software when the copyright notice and license accompany each copy; the font
must not be sold by itself.

---

## Exact bundled inventory

`THIRD_PARTY_COMPONENTS.md` is generated from the immutable runtime manifest and distinguishes
installer-bundled resources from optional user-supplied compatibility candidates. The manifest
is authoritative for exact upstream revisions, artifact hashes and distribution status of the
recorded candidates; a candidate entry is not approval for the user to obtain or use it.

The supplemental `legal/third-party/manifest.json` binds additional original license and notice
texts to their upstream versions, hashes and scope. Its `README.md` explains unresolved boundaries.
This payload is partial evidence, not a declaration that every recursive dependency or source
delivery obligation has been completed.

## Electron and native libraries (present in Online)

- Electron 42.8.0 includes Chromium 148.0.7778.280 and Node.js 24.18.0. The Electron MIT license
  and Chromium third-party notices accompany the application; their embedded components keep
  their own licenses.
- Electron's FFmpeg is traced to Chromium revision `f45bab87ce4c5fafc67fd53fcde777578d01bfa0`.
  Its recorded Windows x64 configuration uses LGPL-2.1-or-later with GPL, nonfree and version3
  build flags disabled. The corresponding source, necessary build materials and applicable
  replacement conditions must accompany the selected distribution method. This is distinct
  from the GPL-3.0-or-later Gyan command-line candidate below.
- sharp 0.35.4 uses libvips 8.18.6 and additional native libraries. The wrapper's Apache license
  does not replace LGPL, MPL and other applicable dependency terms or their source obligations.
- canvas 1.0.3 includes Skia, ICU and Rust dependencies. The observed cssparser 0.37.0 component
  is MPL-2.0; its covered source and a usable source-access notice must be provided. The current
  identified crate list is not a complete canvas build dependency graph.
- DirectML 1.15.4 runtime binaries use Microsoft's DirectML terms, including Windows/Xbox,
  eligible application integration and notice conditions; the runtime binaries are not covered
  by the package's MIT code license. The ONNX-supplied DXC/DXIL 1.8.2502.8 package assigns its
  LLVM/NCSA terms to these binaries. Electron's Dawn DXC and Windows SDK DLLs have separate
  source/version bindings and notices; the old D3DCompiler patch's precise source provenance
  remains documented as unresolved.

---

## YOLOv8n (subject detection candidate; not bundled)

- **Name**: YOLOv8n (COCO 80-class detection, ONNX export)
- **Source**: https://github.com/ultralytics/ultralytics
- **License**: AGPL-3.0 (Ultralytics) — review before commercial redistribution
- **Use**: Subject Search Phase 1.5 generic subject detection

## YOLOv8n-Face (face detection candidate; not bundled)

- **Name**: yolov8n-face-lindevs (WIDER Face, ONNX)
- **Source**: https://github.com/lindevs/yolov8-face
- **License evidence**: The upstream repository declares MIT. The exact local ONNX file's
  conversion and original-weight license chain remain unconfirmed; repository metadata alone
  is not approval of this differing artifact.
- **SHA-256**: `7202335c41e478b4feccdfd7f09d5cec71007d775e02964a8f115b1687f3db87`
- **Identity rechecked (2026-09-24)**: the local 12,265,790-byte ONNX file matches
  this hash and the runtime manifest. This corrects a stale notice identifier;
  it does not resolve the upstream weight-license chain or approve distribution.
- **Use**: Subject Search Phase 2 face detection (bounding boxes; no landmark head)

## AdaFace (face embedding candidate; not bundled)

- **Name**: CVLFace AdaFace IR-101 (WebFace12M), ONNX conversion
- **Source**: https://huggingface.co/Evn9172/cvlface_adaface_ir101_webface12m_onnx (conversion), https://github.com/mk-minchul/AdaFace (original)
- **License evidence**: The project manifest records Apache-2.0, but the fixed ONNX conversion
  repository contains no license statement substantiating that label for these weights. Original
  checkpoint and conversion permissions remain unresolved; this record is not a license grant.
- **Use**: Subject Search Phase 2 face embedding (512-d, 112x112 aligned input)

## OSNet-AIN (person re-identification candidate; not bundled)

- **Name**: OSNet-AIN x1.0 (MSMT17 + DukeMTMC-reID + CUHK03), ONNX export (dynamic batch)
- **Source**: https://huggingface.co/LibreYOLO/LibreReID-osnet (`osnet_ain_x1_0.pt`, SHA-256 `34c24e98…30b731d1`), ported from https://github.com/KaiyangZhou/deep-person-reid
- **License evidence**: The pinned LibreReID model card declares MIT for its weights and the
  original code is MIT. The exact combined-dataset checkpoint/export lineage still needs a
  matching record; dataset conditions must not be automatically treated as a blanket commercial
  prohibition on every resulting weight file.
- **Export evidence**: The recorded torch/ONNX comparison reported cosine similarity of 1.0;
  this is not proof of bit-for-bit equality, artifact provenance or a license grant.
- **Use**: Subject Search Phase 3 full-body person embedding (512-d, 256x128 input), fallback when no face is visible

## MobileSAM (segmentation candidate; not bundled)

- **Name**: MobileSAM (TinyViT image encoder + SAM mask decoder), ONNX
- **Source**: https://huggingface.co/PulpCut/mobilesam-onnx (conversion), https://github.com/ChaoningZhang/MobileSAM (original)
- **License evidence**: Parent MobileSAM and SAM licenses are Apache-2.0; the fixed PulpCut
  ONNX conversion still needs its precise parent/export provenance recorded.
- **Use**: Subject picker click-to-segment — user clicks a point, decoder produces the subject mask (encoder 28MB, decoder 16.5MB)

## FFmpeg and FFprobe (Offline candidate only; excluded from Online)

- **Name**: Gyan.dev FFmpeg 8.1.2 full build
- **Source**: https://www.gyan.dev/ffmpeg/builds/
- **License**: GPL-3.0-or-later
- **Review status**: Legal review required; source-correspondence and distribution obligations are not yet closed
- **Use**: Video metadata, thumbnails, frame extraction and subtitle processing

## Multilingual CLIP Text Encoder (Offline candidate only; excluded from Online)

- **Name**: sentence-transformers/clip-ViT-B-32-multilingual-v1 (multilingual DistilBERT text encoder, official ONNX quint8 export)
- **Source**: https://huggingface.co/sentence-transformers/clip-ViT-B-32-multilingual-v1
- **License**: Apache License 2.0
- **SHA-256** (`onnx/model_quint8_avx2.onnx`): `fbc8fbeaa5237d96bd1bf430057c70d34de8334a463e933a5faa305f6caeed9c`
- **Use**: Chinese/CJK semantic text search — text-only encoder distilled into the OpenAI CLIP ViT-B/32 embedding space (512-d), comparable with existing CLIP image embeddings without re-embedding the library

---

## Compliance status

- Components marked `recorded` have engineering provenance recorded; this does not replace required license texts or legal review.
- Ultralytics YOLOv8n, YOLOv8-Face derivative provenance, AdaFace and OSNet training-data
  provenance, the PulpCut ONNX conversion and the bundled FFmpeg build remain
  `legal-review-required`.
- The five model candidates above are absent from the installer. Users may import only
  interface-compatible ONNX files through Model Platform and remain responsible for obtaining
  lawful model rights; the application does not silently download these candidates.
- DINO, CLIP and multilingual CLIP use a different managed path: after a user starts a setup
  or library-preparation workflow, missing files may be fetched from pinned Hugging Face URLs
  into the user's data directory with size/hash checks. This is separate acquisition, not
  inclusion of model weights in the installer. No model's applicable terms are waived by using
  an import dialog or a download button.
- The project release mode has been selected as proprietary and is marked `UNLICENSED` in
  `package.json`. The project and its native addon remain `project-license-pending` until the
  copyright-holder identity, final EULA, approval metadata and evidence are completed.
- Until those statuses are resolved, generated installers are internal validation candidates and are not approved for public or commercial distribution.

## Included third-party source files

The `covered-source/` directory next to this notice contains local source archives and
their access instructions. Open Settings → Third-party licenses, then `covered-source/README.md`.
The identified cssparser-family source files remain under MPL-2.0; the applicable upstream
licenses and copyright notices are included with the source. You may obtain these files without
network access, an account, or an additional payment. Siftory's other terms do not restrict the
rights granted to you in those MPL-covered source files.

This directory identifies the exact components and versions it covers. It is not a claim that
all native-library source obligations or the complete native dependency inventory are finished.
It does not include Siftory's proprietary application source or model weights.

## Qwen3-VL and SenseVoice (optional external candidates; not bundled)

- The official Qwen3-VL-2B-Instruct GGUF candidate has a pinned Apache-2.0 declaration. The
  Ollama qwen3-vl:2b candidate's Apache license layer is bound to its fixed model manifest; its
  configuration identifies Thinking, despite the historical Instruct label. Neither weight
  is included in this installer. Exact use, notices and any future redistribution are separate decisions.
- Fixed FSMN-VAD v2.0.4 and CAM++ v2.0.2 model cards declare Apache-2.0. They are external
  candidates and must not be assigned SenseVoice's separate custom model terms.
- SenseVoiceSmall's pinned custom FunASR Model License v1.1 has unresolved interpretation for
  the intended commercial use and conversion/redistribution. It remains external; this notice
  does not claim either an unconditional commercial grant or a blanket ban.
- An automatic download is not treated as approval. Components with `manual-review` fetch policy
  stay excluded from every installer.

---

_Last updated: 2026-09-25_
