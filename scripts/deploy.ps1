# Deploy (or update) the whole stack: infrastructure, Lambda code, and the static site.
param(
  [string]$AwsProfile = 'default',
  [string]$Region = 'us-east-1',
  [string]$StackName = 'hn-reader'
)
# Windows PowerShell treats any native stderr output as an error under 'Stop', so rely on exit codes instead.
$ErrorActionPreference = 'Continue'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Invoke-Aws {
  $out = aws @args --profile $AwsProfile --region $Region
  if ($LASTEXITCODE -ne 0) { throw "aws $($args -join ' ') failed" }
  $out
}

function Test-Aws {
  aws @args --profile $AwsProfile --region $Region 2>&1 | Out-Null
  $LASTEXITCODE -eq 0
}

foreach ($name in @('/hn-reader/gemini-api-key')) {
  $found = Invoke-Aws ssm describe-parameters --parameter-filters "Key=Name,Values=$name" --query 'length(Parameters)' --output text
  if ($found -ne '1') { throw "Missing SSM parameter $name. Run scripts/set-secrets.ps1 first." }
}

$account = Invoke-Aws sts get-caller-identity --query Account --output text
$artifacts = "hn-reader-artifacts-$account-$Region"
if (-not (Test-Aws s3api head-bucket --bucket $artifacts)) { Invoke-Aws s3 mb "s3://$artifacts" | Out-Null }

New-Item -ItemType Directory -Force .build | Out-Null
Write-Host 'Packaging...'
Invoke-Aws cloudformation package --template-file template.yaml --s3-bucket $artifacts --output-template-file .build/packaged.yaml | Out-Null

Write-Host 'Deploying stack (first deploy takes ~5 minutes while CloudFront provisions)...'
Invoke-Aws cloudformation deploy --template-file .build/packaged.yaml --stack-name $StackName `
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND --no-fail-on-empty-changeset

$o = @{}
foreach ($key in 'SiteUrl', 'BucketName', 'DistributionId', 'RefreshFunctionName') {
  $o[$key] = Invoke-Aws cloudformation describe-stacks --stack-name $StackName --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue" --output text
}

Write-Host 'Uploading site...'
Invoke-Aws s3 sync site/ "s3://$($o.BucketName)/" --delete --exclude 'data/*' --exclude 'cache/*' --cache-control 'public, max-age=300' | Out-Null
Invoke-Aws cloudfront create-invalidation --distribution-id $o.DistributionId --paths '/*' | Out-Null

if (-not (Test-Aws s3api head-object --bucket $o.BucketName --key data/stories.json)) {
  Write-Host 'No stories yet, so starting the first refresh (takes a minute or two)...'
  Invoke-Aws lambda invoke --function-name $o.RefreshFunctionName --invocation-type Event .build/invoke.json | Out-Null
}

Write-Host "`nDone. Your site: $($o.SiteUrl)"
