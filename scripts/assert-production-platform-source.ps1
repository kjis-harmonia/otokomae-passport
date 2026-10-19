$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskGitOptions = @('-c', ('safe.directory=' + $taskRoot.Replace('\','/')), '-C', $taskRoot)
$taskBranch = & git @taskGitOptions branch --show-current
if ($LASTEXITCODE -ne 0 -or $taskBranch -ne 'release/20261020') { throw 'Expected release/20261020; stop' }
$taskDirty = & git @taskGitOptions status --porcelain
if ($LASTEXITCODE -ne 0 -or $taskDirty) { throw 'Working tree is not clean; stop' }
$taskFunctions = & git @taskGitOptions rev-parse 'HEAD:supabase/functions'
if ($LASTEXITCODE -ne 0 -or $taskFunctions -ne '7e980b5f65d36bb3735e1851a64800c8450cebb4') { throw 'Reviewed Edge source changed; stop' }
$taskConfig = & git @taskGitOptions rev-parse 'HEAD:supabase/config.toml'
if ($LASTEXITCODE -ne 0 -or $taskConfig -ne '6bd1ccae724058b9b6d46ef53448b9f67f6583f2') { throw 'Reviewed JWT configuration changed; stop' }
Write-Output 'SOURCE OK: release/20261020, reviewed Edge source and JWT config, clean working tree'
& git @taskGitOptions log -1 --format='%H'
if ($LASTEXITCODE -ne 0) { throw 'Cannot read release commit' }
