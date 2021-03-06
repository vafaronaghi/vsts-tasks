[CmdletBinding()]
param()

# Arrange.
. $PSScriptRoot/../../lib/Initialize-Test.ps1
$module = Microsoft.PowerShell.Core\Import-Module $PSScriptRoot/../../../Tasks/AzurePowerShell/ps_modules/VstsAzureHelpers_ -PassThru
& $module { $script:azureModule = @{ Version = [version]'1.0' } }
$endpoint = @{
    Auth = @{
        Scheme = 'Certificate'
    }
    Data = @{
        SubscriptionId = 'Some subscription ID'
        SubscriptionName = 'Some subscription name'
    }
}
$certificate = 'Some certificate'
$variableSets = @(
    @{ StorageAccount = $null ; EnvironmentName = $null}
    @{ StorageAccount = $null ; EnvironmentName = ""}
    @{ StorageAccount = $null ; EnvironmentName = "AzureCloud"}
    @{ StorageAccount = $null ; EnvironmentName = "AzureUSGovernment"}
    @{ StorageAccount = 'Some storage account' ; EnvironmentName = $null}
    @{ StorageAccount = 'Some storage account' ; EnvironmentName = ""}
    @{ StorageAccount = 'Some storage account' ; EnvironmentName = "AzureCloud"}
    @{ StorageAccount = 'Some storage account' ; EnvironmentName = "AzureUSGovernment"}
)
foreach ($variableSet in $variableSets) {
    Write-Verbose ('-' * 80)
    Unregister-Mock Add-Certificate
    Unregister-Mock Set-AzureSubscription
    Unregister-Mock Set-CurrentAzureSubscription
    Unregister-Mock Set-UserAgent
    Register-Mock Add-Certificate { $certificate }
    Register-Mock Set-AzureSubscription
    Register-Mock Set-CurrentAzureSubscription
    Register-Mock Set-UserAgent

    # Act.
    & $module Initialize-AzureSubscription -Endpoint $endpoint -StorageAccount $variableSet.StorageAccount
	
    if( $variableSet.Environment ){
        $environmentName = $variableSet.Environment
    }else{
        $environmentName =  'AzureCloud'
    }
	
	# setting environment to endpoint
	$endpoint.Data.Environment = $variableSet.Environment
	
    # Assert.
    Assert-WasCalled Add-Certificate -- -Endpoint $endpoint
    if ($variableSet.StorageAccount) {
        # The CurrentStorageAccountName parameter ends in ":" for the assertion because it's splatted. 
        Assert-WasCalled Set-AzureSubscription -- -SubscriptionName $endpoint.Data.SubscriptionName -SubscriptionId $endpoint.Data.SubscriptionId -Certificate $certificate -Environment $environmentName -CurrentStorageAccountName: $variableSet.StorageAccount
    } else {
        Assert-WasCalled Set-AzureSubscription -- -SubscriptionName $endpoint.Data.SubscriptionName -SubscriptionId $endpoint.Data.SubscriptionId -Certificate $certificate -Environment $environmentName
    }

    Assert-WasCalled Set-CurrentAzureSubscription -- -SubscriptionId $endpoint.Data.SubscriptionId -StorageAccount $variableSet.StorageAccount
}
