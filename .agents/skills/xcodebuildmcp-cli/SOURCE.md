# Source and modifications

This package is a compact repository-local adaptation of the supplied official XcodeBuildMCP
CLI skill. The underlying open-source CLI and MCP server are maintained at:

- Repository: https://github.com/getsentry/XcodeBuildMCP
- Official CLI documentation: https://www.xcodebuildmcp.com/docs/cli
- Official tools reference: https://www.xcodebuildmcp.com/docs/tools

XcodeBuildMCP is MIT-licensed. The upstream license notice is preserved in LICENSE. No
XcodeBuildMCP source code is vendored here; this package keeps the help-first CLI workflow and
adds Companion-specific handoffs, fail-closed installation guidance, and verification boundaries.
