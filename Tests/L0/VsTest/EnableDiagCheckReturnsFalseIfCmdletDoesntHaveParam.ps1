[cmdletbinding()]
param()

. $PSScriptRoot\..\..\lib\Initialize-Test.ps1

Register-Mock InvokeVsTestCmdletHasMember { return $false } -- -memberName "DiagFileName"

$vstestVersion = "15"

. $PSScriptRoot\..\..\..\Tasks\VsTest\Helpers.ps1
$enableDiag = ShouldAddDiagFlag $vstestVersion
Assert-AreEqual $enableDiag $false