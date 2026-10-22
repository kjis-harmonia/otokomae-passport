$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskGitOptions = @('-c', ('safe.directory=' + $taskRoot.Replace('\','/')), '-C', $taskRoot)

function Assert-ReleaseWorktree {
  $taskBranch = & git @taskGitOptions branch --show-current
  if ($LASTEXITCODE -ne 0 -or $taskBranch -ne 'release/20261020') { throw 'Expected release/20261020; stop' }
  $taskDirty = & git @taskGitOptions status --porcelain --untracked-files=all
  if ($LASTEXITCODE -ne 0 -or $taskDirty) { throw 'Working tree is not clean; stop' }
}

Assert-ReleaseWorktree
$taskOrigin = & git @taskGitOptions remote get-url origin
if ($LASTEXITCODE -ne 0 -or $taskOrigin -notin @('https://github.com/kjis-harmonia/otokomae-passport.git','git@github.com:kjis-harmonia/otokomae-passport.git')) { throw 'Wrong origin; stop' }
# Only fetch the release reference. Never checkout, pull, merge, reset, or stash.
& git @taskGitOptions fetch origin 'refs/heads/release/20261020:refs/remotes/origin/release/20261020'
if ($LASTEXITCODE -ne 0) { throw 'Cannot fetch latest release; stop' }
$taskHead = & git @taskGitOptions rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot read local release commit; stop' }
$taskRemote = & git @taskGitOptions rev-parse refs/remotes/origin/release/20261020
if ($LASTEXITCODE -ne 0 -or $taskHead -ne $taskRemote) { throw 'Local HEAD is not the latest origin/release/20261020; stop' }
$taskFunctions = & git @taskGitOptions rev-parse 'HEAD:supabase/functions'
if ($LASTEXITCODE -ne 0 -or $taskFunctions -ne '7e980b5f65d36bb3735e1851a64800c8450cebb4') { throw 'Reviewed Edge source changed; stop' }
$taskConfig = & git @taskGitOptions rev-parse 'HEAD:supabase/config.toml'
if ($LASTEXITCODE -ne 0 -or $taskConfig -ne '6bd1ccae724058b9b6d46ef53448b9f67f6583f2') { throw 'Reviewed JWT configuration changed; stop' }
Assert-ReleaseWorktree
$taskHeadAgain = & git @taskGitOptions rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $taskHeadAgain -ne $taskHead) { throw 'Commit changed during verification; stop' }
Write-Output 'SOURCE OK: release/20261020, latest origin commit, clean working tree, reviewed Edge/JWT source'
Write-Output $taskHead
