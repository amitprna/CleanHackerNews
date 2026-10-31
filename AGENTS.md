# Deploying Clean Hacker News (for AI agents)

Goal: the user ends up with their own copy of the site on their AWS account. Work through the steps in order and confirm each check before moving on.

## Ask the user first
- Which AWS region (default `us-east-1`) and AWS CLI profile (default `default`).
- Whether they have a Gemini API key. If not, send them to https://aistudio.google.com/apikey.
- Never ask them to paste the key into chat. They enter it themselves in step 4.

## Steps
1. **Tools.** `node -v` is 20 or newer; `aws --version` is v2. Install anything missing, with the user's OK.
2. **AWS sign-in.** `aws sts get-caller-identity --profile <profile>` returns an account. If not, have the user run `aws configure`.
3. **Dependencies.** `npm install` in the repo folder.
4. **Gemini key.** Open a terminal the user can type in and run `powershell -ExecutionPolicy Bypass -File scripts/set-secrets.ps1 -AwsProfile <profile> -Region <region>`. The user pastes the key there. Check: `aws ssm describe-parameters --parameter-filters Key=Name,Values=/hn-reader/gemini-api-key` lists one parameter.
5. **Deploy.** `powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 -AwsProfile <profile> -Region <region>`. It takes about 5 minutes the first time and ends with `Done. Your site: https://….cloudfront.net`. It also starts the first refresh.
6. **Check.** After about 2 minutes, `https://<site>/data/stories.json` returns stories with summaries. Open the site and give the user the address.
7. **Optional short address.** Put the CloudFront address into `forwarder/netlify.toml` and `forwarder/_redirects`. The user drags the `forwarder` folder onto https://app.netlify.com/drop and signs up there; you can't do this step for them.

## On macOS or Linux
The scripts are PowerShell. Install PowerShell 7 and run them with `pwsh -File …` instead of `powershell -ExecutionPolicy Bypass -File …`.

## Undo
1. Empty the site bucket: `aws s3 rm s3://<BucketName> --recursive` (BucketName is a stack output).
2. `aws cloudformation delete-stack --stack-name hn-reader`.
3. Delete the deploy bucket `hn-reader-artifacts-<account>-<region>` and the parameter `/hn-reader/gemini-api-key`.
