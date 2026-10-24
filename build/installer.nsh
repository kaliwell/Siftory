; Alpha release reminder. This adds a welcome page, not a proprietary license gate.
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Siftory Alpha 测试版"
  !define MUI_WELCOMEPAGE_TEXT "当前为 Alpha 测试版本，请先备份数据。$\r$\n$\r$\n升级前请正常退出旧版，备份整个应用数据目录，以及原图片、视频和 PSD/AI 工程文件。不要同时运行多个版本。$\r$\n$\r$\nAlpha test build: back up your application data and original media before installing or upgrading. Do not run old and new versions together.$\r$\n$\r$\n本安装包不捆绑 AI 模型，相关功能需在软件内另行配置。"
  !insertmacro MUI_PAGE_WELCOME
!macroend
