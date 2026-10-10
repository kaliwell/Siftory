{
  "targets": [
    {
      "target_name": "fast_scanner",
      "sources": ["fast_scanner.cc", "rotating_logger.cc"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "conditions": [
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 2,
              "AdditionalOptions": ["/utf-8", "%(AdditionalOptions)"]
            },
            "VCLinkerTool": {
              "AdditionalOptions": ["/Brepro", "%(AdditionalOptions)"]
            }
          }
        }]
      ]
    }
  ]
}
