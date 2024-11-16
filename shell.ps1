#!/usr/bin/env sh
echo --% >/dev/null;: ' | out-null
<#'


#
# sh part
#
"$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/build/Release/zero_sqlite3" "$@"
# end bash part

exit #>


#
# powershell part
#
$scriptDir = (Get-Item -Path $MyInvocation.MyCommand.Definition).DirectoryName
& (Join-Path $scriptDir "build" "Release" "zero_sqlite3.exe") @args

