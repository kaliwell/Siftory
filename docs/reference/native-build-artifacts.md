# Native 构建产物说明

`native/` 同时包含源码和本机生成产物，需要明确边界。

## 源码

这些文件应作为源码维护：

- `native/binding.gyp`
- `native/fast_scanner.cc`
- `native/stb_image.h`
- `native/stb_image_resize2.h`

## 本机产物

这些目录由 `node-gyp` / 构建脚本生成，不应作为源码提交：

- `native/build/`
- `native/build-node/`
- `native/build-electron/`

其中：

- `native/build/Release/fast_scanner.node`：当前 Node ABI 测试构建产物。
- `native/build-node/Release/fast_scanner.node`：构建脚本复制的 Node ABI 产物。
- `native/build-electron/Release/fast_scanner.node`：Electron ABI 产物，打包时通过 `package.json` 的 `extraResources` 放入应用资源目录。

## 常用命令

```bash
npm.cmd run build:native
npm.cmd run build:native:electron
npm.cmd run test:native
```

## 注意

如果 `npm.cmd run build` 失败并提示 `fast_scanner.node` 被占用，通常是正在运行的应用或开发进程加载了 native addon。先关闭对应进程，再重新构建。
