# VAL-011 CUDA optional runtime approval packet

> 状态：当前
> 更新日期：2026-08-17
> 范围：CUDA optional runtime engineering evidence; no legal approval
> 替代文档：无

Date: 2026-08-09

> Engineering evidence only. This document is not legal advice, acceptance of an NVIDIA agreement,
> or authorization to distribute any component. Every decision in
> `legal/license-decisions.json` remains `pending` until a real authorized person records the
> decision and its evidence.

## Current status at 2026-08-09 20:55 CST

- Engineering readiness is true: the runtime manifest is valid and all four CUDA components remain
  optional with `defaultBundled=false`.
- The project license/EULA decision and all four component decisions are still `pending`; zero of
  five required approvals are complete.
- The scheduled post-approval regression is `waiting-for-prerequisites` and has not run. It cannot
  make `VAL-011` completion-ready until the approval gate and bounded technical suite both pass.
- No approval record, acceptance flag, runtime download or distribution state was changed while
  recording this status.

## Proposed release boundary

- Platform: Windows x64 with an NVIDIA GPU.
- Delivery: optional private runtime; every CUDA component remains `defaultBundled: false`.
- Product behavior: the application has substantial independent functionality, only the
  FloatingClock CUDA worker accesses the private runtime, and DirectML/CPU remain the fallback.
- Source artifacts: immutable upstream archives with pinned versions, entry paths, sizes and
  SHA-256 values in `resources/runtime-manifest.json`.
- This review does not authorize a standalone CUDA/cuDNN package, an NVIDIA developer tool, a
  non-NVIDIA target, a critical application, or a prohibited export/end use.

## Evidence matrix

| Decision id                                | Engineering finding                                                                                                                                                                     | Required decision/evidence before approval                                                                                                                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `microsoft-onnxruntime-gpu-windows-1-24-3` | ONNX Runtime 1.24.3 uses the MIT license. Distribution is permitted if the copyright and permission notice are included. The manifest pins the NuGet license and third-party notices.   | Confirm the packaged `LICENSE.txt` and `ThirdPartyNotices.txt`, permitted profiles and authorized reviewer.                                                                                                                         |
| `nvidia-cuda-12-8-embedding-runtime`       | CUDA 12.8.1 Attachment A identifies the Windows runtime, cuBLAS, cuFFT and NVRTC DLL families used by the manifest as distributable. The general distribution requirements still apply. | An authorized adult/entity representative must accept the CUDA agreement and confirm application-only access, material additional functionality, consistent downstream terms, export/end-use scope, notices and permitted profiles. |
| `nvidia-cudnn-9-19-1-cuda12-runtime`       | The cuDNN supplement identifies runtime `.dll` files as distributable. The manifest selects only DLLs and the archive license.                                                          | An authorized adult/entity representative must accept the cuDNN agreement and confirm the same distribution, export/end-use, notice and profile restrictions.                                                                       |
| `floating-clock-cuda-embedding-worker`     | The worker is project-owned code and is not enabled or bundled by default. Technical parity/provider gates are recorded in the CUDA PoC.                                                | Identify the copyright holder, approve a final project license/EULA, confirm authority to license the worker, select `project-license`, and attach the final license file.                                                          |

## Primary sources

- ONNX Runtime 1.24.3 MIT license:
  <https://github.com/microsoft/onnxruntime/blob/v1.24.3/LICENSE>
- CUDA 12.8.1 agreement and Attachment A:
  <https://docs.nvidia.com/cuda/archive/12.8.1/eula/index.html#attachment-a>
- CUDA 12.8.1 redistributable inventory and hashes:
  <https://developer.download.nvidia.com/compute/cuda/redist/redistrib_12.8.1.json>
- cuDNN agreement and supplement:
  <https://docs.nvidia.com/deeplearning/cudnn/backend/v9.19.0/reference/eula.html>
- cuDNN 9.19.1 redistributable inventory and hashes:
  <https://developer.download.nvidia.com/compute/cudnn/redist/redistrib_9.19.1.json>
- Technical CUDA provider evidence: `docs/benchmarks/2026-08-07-dino-clip-cuda-poc.md`.

## Authorized sign-off data required

The approving person must provide all of the following; automation must not infer any value:

1. Legal name and authority of the copyright holder or entity accepting the agreements.
2. Reviewer identity and an ISO-8601 approval time.
3. The exact permitted release profiles (`online`, `offline`, or both), sales channels,
   territories and export/end-use confirmation.
4. A final, non-template project license/EULA for project-owned binaries.
5. Evidence that every upstream license/notice file is included in the delivered optional runtime.
6. A recorded acceptance or counsel-review reference for both NVIDIA agreements.

Only after those facts exist may the four component records change from `pending` to `approved`.
The intended resolutions are `upstream-license` for ONNX Runtime, CUDA and cuDNN, and
`project-license` for the FloatingClock worker. Placeholders or a generic user instruction are not
approval evidence.

Each approved component must also include an `approvalScope` object. The machine gate requires
non-empty `distributionChannels` and `territories`, `exportEndUseConfirmed: true`, both
`online` and `offline` in `permittedProfiles`, a real reviewer/time/evidence record and safe,
existing license/notice files. NVIDIA decisions additionally require
`agreementAcceptedConfirmed`, `applicationOnlyAccessConfirmed`,
`materialAdditionalFunctionalityConfirmed` and a non-placeholder
`agreementAcceptanceReference`. The project-owned worker requires
`authorityToLicenseConfirmed` and a final project license/EULA whose name is not a draft or
template. Merely changing `status` to `approved` fails closed.

## Post-approval verification

Run these only after the decisions and final license files are complete:

```powershell
npm.cmd run licenses:check
npm.cmd run licenses:cuda-approval-check
npm.cmd run licenses:gate -- --profile=online
npm.cmd run licenses:gate -- --profile=offline
npm.cmd run resources:verify
npm.cmd run cuda-runtime:verify
npm.cmd run test:model-download
npm.cmd run release:gate -- --profile=online
npm.cmd run release:gate -- --profile=offline
```

The scheduled value TODO monitor performs a bounded, non-mutating first verification immediately
after the machine approval gate becomes complete. It reruns the CUDA installer contract,
online/offline package-profile contract, pinned resource fetch/offline-cache tests, worker provider
gate and DirectML fallback tests. `VAL-011` is not completion-ready if that post-approval regression
fails. This automation never passes an acceptance flag, downloads a runtime or edits the approval
records.

No CUDA runtime was downloaded, bundled or installed while preparing this packet.
