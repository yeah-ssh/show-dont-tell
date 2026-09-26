# Customer reply style

Short, warm, specific. The customer should understand what happened in 20 seconds.

## Reproduced and fixed
```
Subject: Re: <their ticket title>

Hi <first name>,

Thanks for reporting this. You were right: <one sentence describing the bug in their words>.

We reproduced it on <environment> and fixed it. Here's the before and after:

<evidence markdown: GIF + video link>

The fix is in review now and will ship in the next release. <If there's a workaround, one line.>

Thanks again for taking the time to tell us.
— Demo Shop Support
```

## Could not reproduce
```
Subject: Re: <their ticket title>

Hi <first name>,

Thanks for the report. We tried to reproduce it and couldn't yet. Here's exactly what we tested:

<evidence markdown: attempts video>

- <environment 1>: works as expected
- <environment 2>: works as expected

<If there's a hypothesis: "One possibility: <plain-words hypothesis>.">

Could you tell us <ONE precise question: e.g. your exact Safari version (Safari menu → About Safari), or any error shown in the console>? That will let us pin it down.

— Demo Shop Support
```

## Never
- Blame the customer, or promise dates you don't control.
- Paste stack traces, internal file paths, or other people's data.
- Say "fixed" without an evidence link.
