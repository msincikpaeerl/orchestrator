# Requests

A request is what you want, in your own words: a new website, a feature for one of your projects, a change. The Project Manager, an agent, will read it, ask you questions if something is unclear, and propose a plan: the tickets to do, in order. You approve the plan, and the other agents do the tickets.

In this version you can submit requests and add to them, but nothing starts yet: the Project Manager and the plans come with a later version. A request stays **Open** until then.

## Submit a request

1. Open **Requests**, then click **New request**.
2. In **What do you want?**, describe it as you would to a person: what it is for, who uses it, what matters to you, what you do not want. Markdown is allowed. The text can be as long as **Longest ticket description** allows (20,000 characters by default, in [Settings](settings.md)).
3. In **Project**, choose the project it is about, or **A new project** if it needs a new one: the Project Manager then proposes the project too. Archived projects are not listed. A project whose repository setup is not finished can be chosen.
4. Click **Submit the request**. Its page opens.

For example: "A simple website with a home page and a contact form. A message sent through the form is saved on the computer running the site, and the visitor sees a confirmation. No e-mail."

The request cannot be edited once submitted: add what you forgot as a comment (below).

## Follow your requests

**Requests** lists every request, newest first, each with its number ("Request 7"), its first line, its status and its project ("For a new project" when it has none). Click one to open its page.

A request's page shows its status, its project, when you submitted it, its full text, its plan (none yet in this version) and the conversation: your comments, and later the Project Manager's questions and your answers.

| Status | Meaning |
|---|---|
| Open | Submitted; nothing is working on it yet. |
| Planning | The Project Manager is working on it (later version). |
| Plan to review | A plan waits for your approval (later version). |
| Closed | Done with (later version). |

The [Activity](activity.md) log shows each request submitted and each comment added, under the kind **Requests**.

## Add a comment

On the request's page, write in **Add a comment** and click **Add comment**: something you forgot, a detail, a change of mind. The Project Manager will read every comment when it plans the request. A comment can be as long as **Longest comment** allows.

## Questions

While it plans a request (later version), the Project Manager may need a decision only you can make. It asks a question, and the request stays **Planning**:

- **Needs you** shows **Question on request 7 (WEB): <its first line>**, or **(new project)** for a request with no project, with the question and an answer box;
- the request's page says "Planning: the Project Manager waits for your answer." and shows the same yellow box between the request and its plan.

1. Read the question.
2. Write your answer in **Your answer**, on either screen. Markdown is allowed; the answer can be as long as **Longest comment** allows.
3. Click **Send answer**.

The question and your answer stay in the request's conversation, marked **Question from agent …** and **Your answer**, and the item leaves **Needs you**. The Project Manager goes on:

- within the **Waiting run lifetime** (30 minutes by default), it receives your answer at once, in the same session;
- after it, its session was closed to free the machine; your answer starts it again on the same machine, where it finds the request and your answer;
- if that machine is offline, the planning run fails because of it (this does not count as a failed attempt), the request goes back to **Open**, and your answer stays in the conversation, with a note from the Orchestrator saying so: the next planning run reads it.

If the planning run ends before you answer (it crashed or was stopped), the request goes back to **Open** and the question leaves **Needs you**; it stays in the conversation. A request of an archived project cannot be answered.
