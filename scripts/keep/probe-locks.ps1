# probe-locks.ps1 — which native binaries of an installed build are mapped by a running server?
#
# A mapped .node or .dll makes an in-place `npm install -g` fail or leave a mixed
# package, which is why own builds install side by side. Read-only: opening a file
# for write access without writing changes nothing.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts/keep/probe-locks.ps1 [-Path <install dir>]
param(
	[string]$Path = "$env:LOCALAPPDATA\local-memory-mcp-builds"
)

if (-not (Test-Path $Path)) {
	Write-Error "No install directory at $Path"
	exit 1
}

$bins = Get-ChildItem -Recurse -File -Path $Path -Include *.node, *.dll -ErrorAction SilentlyContinue
foreach ($bin in $bins) {
	try {
		$stream = [IO.File]::Open($bin.FullName, 'Open', 'ReadWrite', 'None')
		$stream.Close()
	}
	catch [System.IO.IOException] {
		"LOCKED $($bin.FullName.Substring($Path.Length))"
	}
}
"checked $($bins.Count) binaries under $Path"

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object CommandLine -match 'local-memory-mcp' | ForEach-Object {
	$parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($_.ParentProcessId)"
	$build = if ($_.CommandLine -match '\d+\.\d+\.\d+-[0-9a-f]{8}') { $Matches[0] } else { 'unversioned' }
	"server $($_.ProcessId) build $build started $($_.CreationDate) parent $($parent.Name) $($parent.ProcessId)"
}
