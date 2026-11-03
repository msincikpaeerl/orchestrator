# Requests

A request is what you want, in your own words: a new website, a feature for one of your projects, a change. The Project Manager, an agent, will read it, ask you questions if something is unclear, and propose a plan: the tickets to do, in order. You approve the plan, and the other agents do the tickets.

From version 0.6.0, the Orchestrator's scheduler starts the Project Manager on a request by itself, as soon as a machine and its Claude account are free (see [What starts by itself](runs.md#what-starts-by-itself)). You review its plan, change it if you want, and approve it or reject it with feedback (see [Review a plan](#review-a-plan)). A plan for a new project creates the project and its GitHub repository when you approve it (see [Approve a plan for a new project](#approve-a-plan-for-a-new-project)).

## Submit a request

1. Open **Requests**, then click **New request**.
2. In **What do you want?**, describe it as you would to a person: what it is for, who uses it, what matters to you, what you do not want. Markdown is allowed. The text can be as long as **Longest ticket description** allows (20,000 characters by default, in [Settings](settings.md)).
3. In **Project**, choose the project it is about, or **A new project** if it needs a new one: the Project Manager then proposes the project too. Archived projects are not listed. A project whose repository setup is not finished can be chosen.
4. Click **Submit the request**. Its page opens.

For example: "A simple website with a home page and a contact form. A message sent through the form is saved on the computer running the site, and the visitor sees a confirmation. No e-mail."

The request cannot be edited once submitted: add what you forgot as a comment (below).

## Follow your requests

**Requests** lists every request, newest first, each with its number ("Request 7"), its first line, its status and its project ("For a new project" when it has none). Click one to open its page.

A request's page shows its status, its project, when you submitted it, its full text, its plan (see [Review a plan](#review-a-plan)), the earlier plans and the conversation: your comments, and later the Project Manager's questions and your answers.

| Status | Meaning |
|---|---|
| Open | Waiting for the Project Manager: the scheduler starts its planning run when a machine is free. **Activity > Queue** says why it waits (see [Queue](activity.md#queue)). |
| Planning | The Project Manager is working on it. |
| Plan to review | A plan waits for your review: see [Review a plan](#review-a-plan). |
| Closed | You approved its plan, or closed the request. A closed request is final. |

The [Activity](activity.md) log shows each request submitted, each comment added and each change to a plan, under the kind **Requests**.

## Add a comment

On the request's page, write in **Add a comment** and click **Add comment**: something you forgot, a detail, a change of mind. The Project Manager will read every comment when it plans the request. A comment can be as long as **Longest comment** allows.

## Questions

While it plans a request, the Project Manager may need a decision only you can make. It asks a question, and the request stays **Planning**:

- **Needs you** shows **Question on request 7 (WEB): <its first line>**, or **(new project)** for a request with no project, with the question and an answer box;
- the request's page says "Planning: the Project Manager waits for your answer." and shows the same yellow box between the request and its plan.

1. Read the question.
2. Write your answer in **Your answer**, on either screen. Markdown is allowed; the answer can be as long as **Longest comment** allows.
3. Click **Send answer**.

The question and your answer stay in the request's conversation, marked **Question from agent …** and **Your answer**, and the item leaves **Needs you**. The Project Manager goes on:

- within the **Waiting run lifetime** (30 minutes by default), it receives your answer at once, in the same session;
- after it, its session was closed to free the machine; your answer starts it again on the same machine, where it finds the request and your answer;
- if that machine is offline, the planning run fails because of it (this does not count as a failed attempt), the request goes back to **Open**, and your answer stays in the conversation, with a note from the Orchestrator saying so: the next planning run reads it.

If the planning run ends before you answer (it crashed or was stopped), the request goes back to **Open** and the question leaves **Needs you**. It stays on the request's page with the answer box and "Its planning run ended: your answer is kept and the next planning run reads it.": answer it there when you want, and the next planning run finds your answer in the conversation. A question left this way never holds up the next planning run. A request of an archived project cannot be answered.

## When planning starts

The scheduler starts one planning run per request, when you submit it: the request becomes **Planning**, and its conversation says "Started by the scheduler: planning attempt 1 on machine Laptop.". The Project Manager reads the request with its whole conversation, your comments and answers included, and the project's tickets. While it plans, the request is not started again. If its Claude account reaches a usage limit, the planning run pauses and **Needs you** shows **Run paused: …** with **Request 7 (WEB): <its first line>**; the scheduler resumes it once the limit resets, where it stopped (see [Usage limits](runs.md#usage-limits)).

## If planning fails

A planning run can end without a plan. Each time, the request goes back to **Open** and the Orchestrator adds a note to its conversation saying what happened and whether it counts as a failed attempt:

- it **counts** when the Project Manager's session crashed, ran out of time, used up its reminders without proposing a plan, or gave up because the request cannot be planned (its reasons are then in the conversation, from the Project Manager);
- it **does not count** when you stopped it, or when its machine caused it (offline, revoked, Claude Code missing or too old, Claude Code that could not be started). A machine that caused it is not used again for this request until it connects again.

When the failed attempts reach **Failed attempts before asking you** (2 by default, in [Settings](settings.md) or the project's settings), the request is **stopped**: no planning run starts for it until you decide. **Needs you** then shows **Planning stopped for request 7 (WEB): …**, and the request's page a **Planning stopped** section, each saying how many attempts failed.

**Stop run** on a planning run stops the request in the same way, so it does not start again by itself: the item says "You stopped its planning run at …". It never counts as a failed attempt.

Read the conversation first: add a comment if the request was unclear. Then click **Try again**, in **Needs you** or on the request's page. It starts no session by itself: the failed attempts count from 0 again, the machines left out can be used again, and the Project Manager plans the request again when a machine and its Claude account are free. A request of an archived project cannot be tried again.

## Review a plan

When the Project Manager proposes a plan, the request becomes **Plan to review** and **Needs you** shows **Plan to review for request 7 (WEB): <its first line>** ("(new project)" for a request with no project), "The Project Manager proposed 4 tickets at …" and **Review the plan**, which opens the request's page. Nothing is created in the project until you approve: the plan's tickets have short names (keys) such as `contact`, not numbers.

The **Plan** section shows the Project Manager's summary, the new project it proposes (if any), and each ticket with its type, priority, assignee, description, acceptance criteria and what it waits for: another ticket of the plan, or a ticket of the project.

**Dependencies**, above the tickets (for a plan of two tickets or more), shows the order they can be done in: **Step 1 · waits for nothing**, then **Step 2** for the tickets waiting only for step 1, and so on, as columns with arrows on a computer and as one list on a phone (the same graph as the board's: see [The dependency graph](tickets.md#the-dependency-graph)). A ticket of the project that a plan ticket waits for is shown in step 1 with its number, title and state, and "Already in WEB"; click it to open it. The graph follows your changes at once: edit what a ticket waits for, or remove a ticket, and the steps change. Earlier plans and an approved plan show their graph too.

**Change a ticket.** Click **Edit** under it: its form opens in place, with its type, title, description, acceptance criteria, priority, assignee and **Waits for** (remove one, or add another ticket of the plan or a ticket of the project not cancelled). Click **Save**, or **Cancel** to leave it as it was. A change is refused when it brings a problem (for example a ticket waiting for itself, or a loop of tickets waiting for each other); the problems are listed under the form. A new project's first ticket, its **Bootstrap ticket**, keeps its type, assignee and dependencies: every other ticket waits for it.

**Remove a ticket.** Click **Remove** under it and confirm. The confirmation names the tickets that wait for it: they no longer do. A removed ticket cannot be added back (reject the plan with feedback to get it again), and the plan's last ticket cannot be removed. The bootstrap ticket has no **Remove**.

**Approve.** Click **Approve**, read the confirmation ("It creates 4 tickets in WEB, in To do. …") and click **Approve** again. The Orchestrator checks the whole plan again against your current settings and the project's tickets: if something is wrong, every problem is listed and nothing is created. Otherwise the tickets are created in **To do**, numbered in the plan's order, and the request is **Closed**. The scheduler then starts them by itself as machines are free: each one uses Claude Code sessions from your plan. The section then reads "Plan, approved by you at …", each ticket with a link to the ticket it became ("Created as WEB-12"), and each of those tickets says on its page "From request 7's plan, approved by you". A plan for an archived project cannot be approved. A plan for a new project has a form first: see below.

### Approve a plan for a new project

When the request has no project, the plan proposes one (its name, its kind and a description), and its first ticket is the **Bootstrap ticket**, assigned to the Architect, which sets the project up; every other ticket waits for it. Above **Approve**, the box **The new project** asks what the Projects screen asks for a new repository (see [Create a project with a new repository](projects.md#create-a-project-with-a-new-repository)):

- **Name**: the plan's, which you can change;
- **Key**: suggested from the name; it starts every ticket number and cannot be changed later. The form tells you if another project already uses it;
- **Kind** and **Description**: the plan's (you can change the description later in the project settings). A website or a web app requires the capability `browser-tests` (see [Browser tests](machines.md#browser-tests));
- **Repository name**: made from the name, which you can change; the form tells you if a repository with this name already exists on your GitHub account;
- **Visibility**: **Private** (the default) or **Public**.

To use one of your existing repositories instead, reject the plan with feedback and create the project with **Link an existing repository** on the Projects screen.

Click **Approve** and read the confirmation: "It creates the project Bakery shop (SHOP) and its private repository you/bakery-shop on GitHub with the starting files, then 4 tickets in SHOP, in To do. They wait for the project's setup; then the scheduler starts them by themselves as machines are free: each one uses Claude Code sessions." Click **Approve** again. The Orchestrator checks the plan again; it also adds back to the bootstrap ticket any of its fixed acceptance criteria you removed, and adds one more that names the plan's other tickets by their numbers and titles (with your changes), for example "It builds no feature of the plan's other tickets (SHOP-2 Home page, SHOP-3 Contact form): only the structure, the tooling and one sample test of each test level." (only their numbers when the titles make it too long; none when the plan has no other ticket). If they no longer fit within **Most acceptance criteria**, the approval is refused and says so: remove some of its other criteria. Then, at once:

- the project is created, with the request now belonging to it;
- the tickets are created in **To do**, numbered from 1, the bootstrap ticket first (`SHOP-1`);
- the request is **Closed**, and the plan says "Project SHOP was created: its setup is shown on its page", with a link.

The project's setup then runs as for a project created on the Projects screen: the repository, the starting files, branch protection. Its tickets wait until it is **Ready** (the **Queue** says "the project is not ready"); then the scheduler starts the bootstrap ticket first, since every other ticket waits for it. If the setup fails, the project page and **Needs you** say why, with **Try again** (see [If the setup fails](projects.md#if-the-setup-fails)). A key or a repository name taken in the meantime is refused next to its field, and nothing is created.

**Reject with feedback.** Click **Reject with feedback**, say in **What should change?** what the Project Manager should do differently (required; Markdown is allowed, as long as **Longest comment** allows) and click **Reject with feedback**. The plan moves to **Earlier plans** with your feedback, nothing is created in the project, and the request goes back to **Open**: the scheduler starts a new planning run (one Claude Code session), which reads the rejected plan and your feedback. **Keep reviewing** closes the box.

**Earlier plans** lists the plans rejected before, newest first: click one to see your feedback (or "Rejected: you closed the request.") and its tickets.

## Close a request

When you no longer want a request, click **Close request** at the bottom of its first box, at any status but **Closed**. The confirmation says what it does:

- it is final: a closed request cannot be reopened; submit a new request to ask again;
- its planning run, if one is working, stops now (this does not count as a failed attempt), and its question no longer waits;
- its proposed plan, if any, is rejected: no ticket is created.

Click **Close request** to confirm, or **Keep it open**. Its items leave **Needs you**, and the conversation says the request was closed. You can still add comments to a closed request.
