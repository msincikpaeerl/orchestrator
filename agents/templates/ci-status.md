This is the CI result of commit {{commit}}, which your run handed in on {{submitted}}.
<!-- part: earlier-run -->
This is the CI result of commit {{commit}}, which an earlier run of this ticket (attempt {{attempt}}) handed in on {{submitted}}. Work done since then, yours included, is not part of it.
<!-- part: refused -->
Your latest submission was refused, so its commit has no CI result.
<!-- part: no-submission -->
No work of this ticket has been accepted yet, so there is no CI result to read. CI is read after ticket_submit accepts your work.
<!-- part: no-pull-request -->
The pull request is not opened yet, so CI has not started.
<!-- part: head-moved -->
The pull request's head is now commit {{head}}, another commit: this result is not about it.
<!-- part: read-at -->
This result was read on GitHub on {{at}}.
<!-- part: not-read-yet -->
No result has been read on GitHub yet.
<!-- part: finished -->
It is finished, so it is not read again.
<!-- part: not-finished -->
It is not finished: it is read again at most every {{seconds}} seconds.
<!-- part: limited -->
GitHub's request limit is reached: nothing is asked of GitHub before {{at}}.
<!-- part: read-failed -->
GitHub could not be read just now ({{problem}}): this is the latest result read.
<!-- part: nothing-yet -->
No CI run or status has appeared on GitHub for this commit yet.
<!-- part: conflict -->
The pull request conflicts with {{base}}, so GitHub started no CI, and the work cannot be accepted like this.
<!-- part: no-ci -->
No CI run or status appeared on GitHub: the work passed as "No CI found".
<!-- part: passed -->
CI passed.
<!-- part: failed -->
CI failed: each failed job is listed with its failed steps, each with its part of the job's log.
<!-- part: jobs-problem -->
The failed jobs could not be listed: {{problem}}.
<!-- part: logs-not-read -->
{{count}} failed jobs had their log left unread, because there are too many failed jobs to show: they are listed in logs_not_read with their failed steps. The list of failed jobs is complete; only their logs are missing.
<!-- part: checks-cut -->
{{shown}} of the {{count}} workflow runs and statuses are listed: the others did not fit in this answer.
<!-- part: excerpt-step -->
Step "{{step}}": its own part of the job's log.
<!-- part: excerpt-job-end -->
Step "{{step}}": its part of the log could not be cut out ({{why}}). The log below is the end of the whole job's log, not the step's part.
<!-- part: excerpt-job-end-partial -->
Step "{{step}}": its part of the log could not be cut out ({{why}}). The log below is the end of the part of the job's log that was read, not the step's part.
<!-- part: excerpt-no-step -->
GitHub names no failed step in this job. The log below is the end of the whole job's log.
<!-- part: excerpt-cut -->
Only the end of it is shown.
<!-- part: why-no-times -->
GitHub gave no start or end time for the step
<!-- part: why-ceiling -->
the job's log is larger than Longest CI log read ({{megabytes}} MB), and the step's part does not end within what was read
<!-- part: why-no-timestamps -->
the log's lines carry no timestamp
<!-- part: why-outside-window -->
no line of the log falls within the step's times
<!-- part: why-no-error -->
no ##[error] line falls within the step's times
<!-- part: log-expired -->
GitHub no longer has this job's log (it expired or was deleted).
<!-- part: log-unreachable -->
GitHub could not be reached for this job's log: call ci_status again after {{at}}.
<!-- part: log-rate-limited -->
GitHub's request limit stopped the reading of this job's log: call ci_status again after {{at}}.
<!-- part: log-refused -->
GitHub did not give this job's log: {{message}}
<!-- part: log-cut-to-fit -->
[Cut here: {{count}} earlier characters of this log are not shown, because the answer would be too long for you.]
