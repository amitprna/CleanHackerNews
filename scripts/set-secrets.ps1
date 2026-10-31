# Store the Gemini API key as an SSM SecureString.
# Run this yourself in a terminal; input is hidden and never written to disk or shell history.
param(
  [string]$AwsProfile = 'default',
  [string]$Region = 'us-east-1'
)
$ErrorActionPreference = 'Stop'

function Read-Secret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Save([string]$Name, [string]$Value) {
  aws ssm put-parameter --name $Name --type SecureString --value $Value --overwrite --profile $AwsProfile --region $Region | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not save $Name" }
  Write-Host "Saved $Name"
}

$key = Read-Secret 'Gemini API key (Enter to keep the current one)'
if ($key) { Save '/hn-reader/gemini-api-key' $key }

