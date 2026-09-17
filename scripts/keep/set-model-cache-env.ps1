# Adds MEMORY_EMBED_CACHE_DIR to the user-scope `memory` MCP entry in ~/.claude.json.
# Text edit, not a JSON rewrite: that file can hold keys differing only by case.
# Idempotent: a second run reports the variable is already set and changes nothing.
param(
	[string]$CacheDir = "$env:LOCALAPPDATA\local-memory-mcp-model-cache"
)
$path = "$env:USERPROFILE\.claude.json"
$text = [IO.File]::ReadAllText($path)

if ($text -match 'MEMORY_EMBED_CACHE_DIR') {
	"already set: $(([regex]::Match($text, '"MEMORY_EMBED_CACHE_DIR":\s*"[^"]*"')).Value)"
	exit 0
}

# The empty env block of the memory server: unique enough to target, and asserted below.
$serverAt = $text.IndexOf('local-memory-mcp-builds')
if ($serverAt -lt 0) {
	Write-Error "no local-memory-mcp-builds server found in $path"
	exit 1
}
$envAt = $text.IndexOf('"env": {}', $serverAt)
if ($envAt -lt 0 -or $envAt - $serverAt -gt 400) {
	Write-Error "no empty env block right after the memory server (found at offset $envAt vs server $serverAt)"
	exit 1
}

$backup = "$path.bak-$(Get-Date -Format yyyy-MM-dd-HH-mm-ss)"
[IO.File]::Copy($path, $backup, $true)
$replacement = '"env": {' + "`n" + '        "MEMORY_EMBED_CACHE_DIR": "' + $CacheDir.Replace('\', '/') + '"' + "`n" + '      }'
$updated = $text.Remove($envAt, '"env": {}'.Length).Insert($envAt, $replacement)
[IO.File]::WriteAllText($path, $updated, [Text.UTF8Encoding]::new($false))
"backup $backup"
node -e "const j=require(require('os').homedir()+'/.claude.json');console.log('memory env:', JSON.stringify(j.mcpServers.memory.env))"
