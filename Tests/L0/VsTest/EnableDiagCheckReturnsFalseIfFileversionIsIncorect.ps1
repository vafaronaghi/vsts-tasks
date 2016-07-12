[cmdletbinding()]
param()

# Arrange.
. $PSScriptRoot\..\..\lib\Initialize-Test.ps1

Register-Mock InvokeVsTestCmdletHasMember { return $true } -- -memberName "DiagFileName"
Register-Mock Get-ChildItem { $true } -- -path 'env:system_debug' -erroraction silent
Register-Mock Test-Path { $true } -- -Path "$env:VS150COMNTools\..\IDE\CommonExtensions\Microsoft\TestWindow\vstest.console.exe"
Register-Mock CheckFileVersion { $false } -- -Path "$env:VS150COMNTools\..\IDE\CommonExtensions\Microsoft\TestWindow\vstest.console.exe"

$vstestVersion = "16"
Register-Mock SetRegistryKeyForParallel { } -- -vsTestVersion $vstestVersion 
$path="$env:VS150COMNTools\..\IDE\CommonExtensions\Microsoft\TestWindow\TE.TestModes.dll"
Register-Mock Test-Path { $true } -- -Path $path

. $PSScriptRoot\..\..\..\Tasks\VsTest\Helpers.ps1
$enableDiag = ShouldAddDiagFlag $vstestVersion
Assert-AreEqual $false $enableDiag