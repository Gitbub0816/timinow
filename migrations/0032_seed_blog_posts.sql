-- Six posts, published.
--
-- Content as a migration because content is what this blog was missing: the
-- rendering, the sitemap, the feed and the schema were all built out around a
-- single post, which is scaffolding around an empty building. These are the
-- first floor.
--
-- All six are deliberately NON-CLINICAL. They are about how an emergency
-- hospital works, what to say, what to bring, and what things cost — none of
-- them tells anybody whether their animal is sick, because that is a
-- veterinarian's judgement and not a website's. Anything clinical that gets
-- published here later needs a named veterinarian behind it; see the
-- reviewer columns this repository adds for exactly that.
--
-- INSERT OR IGNORE, keyed on a stable id, so running this twice changes
-- nothing. Editing a post afterwards in the admin console is the normal path;
-- this migration will not reach in and overwrite it.
--
-- published_at is staggered by a minute so the index has a stable order
-- rather than six rows sharing a timestamp and sorting arbitrarily.


INSERT OR IGNORE INTO blog_posts (
  id, slug, author_kind, tenant_id, author_user_id, author_name, provider_name,
  title, excerpt, body_markdown, status, published_at, created_at, updated_at
) VALUES (
  'post_seed01',
  'open-24-hours-does-not-mean-they-can-see-your-dog',
  'platform',
  NULL,
  NULL,
  NULL,
  NULL,
  '“Open 24 hours” does not mean they can see your dog',
  'A hospital can have its lights on, its doors unlocked, and no room. Hours are a property of a building; capacity is a property of an evening.',
  'There is a particular kind of 11pm phone call where the recording says "open twenty-four hours" and then a person picks up and says, gently, that they are not taking anything new tonight.

Both things are true. The lights are on. There are people in the building. The doors are unlocked. And there is no room.

## Hours are a property of a building. Capacity is a property of an evening.

A twenty-four hour emergency hospital has a fixed number of tables, a fixed number of nurses on shift, and an entirely unfixed number of animals that might come through the door. By ten o''clock a hospital that opened the evening empty can be four hours deep: two surgeries, an oxygen cage that is occupied, and a waiting room where everyone has already been told it will be a while.

None of that changes the hours on the door. Google still says open. The map still shows a pin. The website still has the phone number in the header. Every signal you can see from your kitchen says *go here*, and the only signal that would have told you otherwise is inside the building.

So you drive. You carry the cat in. And somebody who has said this sentence eleven times already tonight says it to you.

## What we do about it is boring and it is the whole product

Clinics on Tími tell us whether they can take another patient. Not their hours — their capacity, right now, as of a moment we show you.

That is genuinely the entire idea. It is not clever. It took about four minutes to describe to the first veterinarian we explained it to, and her response was to ask why nobody had done it, which is the response we have gotten roughly every time since.

The hard part was never the concept. The hard part is that it only works if a front desk that is already underwater will tell us the truth, at eleven at night, while the phone is ringing. So the reporting has to be two taps and it has to cost them nothing to say *no, not right now*. A clinic that says no does not pay us and does not get the request. Saying no honestly is free, which is the only way honest answers happen at scale.

## The timestamp is not decoration

Every result on Tími carries the time the clinic reported it. Four minutes ago means something. Yesterday means nothing, and we would rather show you an empty search than pad it with hospitals that stopped answering us at six.

A number with no time attached is a guess wearing a uniform. We would rather hand you something smaller and true.

---

If your animal is in trouble right now, stop reading and call the nearest emergency hospital — tell them what is happening on the way in. Nothing on this site is a substitute for that.',
  'published',
  datetime('now', '-5 minutes'),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO blog_posts (
  id, slug, author_kind, tenant_id, author_user_id, author_name, provider_name,
  title, excerpt, body_markdown, status, published_at, created_at, updated_at
) VALUES (
  'post_seed02',
  'what-the-front-desk-needs-in-the-first-thirty-seconds',
  'platform',
  NULL,
  NULL,
  NULL,
  NULL,
  'What the front desk needs from you in the first thirty seconds',
  'Lead with species, age and the worst symptom, then stop talking. The story matters and it is not the first thing.',
  'The first thirty seconds at the desk decide a surprising amount about your night. Not because anyone is judging you — because the person in front of you is triaging while you talk, and what you say first is what they triage on.

Most people lead with the story. The story is important and it is not the first thing.

## Lead with the thing that would change what happens next

Start with species, age, and the single worst symptom. Then stop talking and let them ask.

> "Ten-year-old lab, he collapsed twice in the last hour and he''s breathing funny."

That is eleven words and it moves a dog to the front of a queue. Compare:

> "So he was fine this morning, we went to the park like always, and then around four I noticed he wasn''t himself, he didn''t finish dinner which is unlike him, and my husband said maybe it''s the heat…"

Everything in the second version matters. A veterinarian will want all of it. But the nurse at the desk needs the first sentence to decide whether you sit down or whether someone comes out with a gurney, and the second version buries it forty seconds deep.

## Have these ready before you walk in

- **Weight**, roughly. Drug doses are weight-based and every estimate they have to make is a delay.
- **Medications**, including the ones you would not think of — the flea treatment, the supplement your mother-in-law recommended, the half a Benadryl.
- **When it started**, in hours. Not "recently."
- **Whether they ate anything they should not have**, and if you are not sure, say you are not sure. "I don''t know" is a real answer and a useful one.
- **Whether they have been spayed or neutered**, which for an unspayed female with a swollen abdomen changes the entire shape of the evening.

If you take a photo of the medication labels before you leave the house, you have solved the hardest of these while you are still calm.

## Two things people apologize for and should not

Bringing in an animal that turns out to be fine. Every emergency veterinarian I have spoken to says the same thing about this, usually with visible feeling: they would rather see forty animals that are fine than miss the one that is not. Nobody is annoyed with you.

Not knowing something. Guessing to seem like a competent owner is worse than the gap. "I''m not sure how much she weighs" gets a scale. "About sixty pounds" when she is forty-two gets a dose.

---

This is about arriving well, not about deciding whether to go. If you are weighing that, call the hospital and describe it — that call is free and they will tell you.',
  'published',
  datetime('now', '-4 minutes'),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO blog_posts (
  id, slug, author_kind, tenant_id, author_user_id, author_name, provider_name,
  title, excerpt, body_markdown, status, published_at, created_at, updated_at
) VALUES (
  'post_seed03',
  'triage-is-not-a-queue',
  'platform',
  NULL,
  NULL,
  NULL,
  NULL,
  'Triage is not a queue',
  'Why the couple who arrived after you went back first, why the wait can get longer once you are there, and what is reasonable to ask.',
  'You get there at 9:40. The couple who arrived at 10:15 go back first. You have been sitting under the same fluorescent light for forty minutes holding a cat carrier on your knees, and it is very hard, in that moment, not to take it personally.

It is not personal. It is the system working exactly as designed, and knowing why makes the wait easier to sit through.

## An emergency hospital is not a queue. It is a sorting machine.

Every animal that comes through the door gets assessed within a couple of minutes of arriving — usually by a nurse, usually faster than you realize it is happening. That assessment produces a rough category, and the categories, not the clock, decide the order.

A dog that cannot breathe goes first. A cat that has been straining in the litter box for six hours goes very soon after, because a blocked cat is a genuine emergency on a timer even though he is walking around looking almost normal. A vomiting dog who is bright, alert, and drinking is stable, and stable means waiting, sometimes for a long time.

The couple who went back before you did not cut. Their animal was sorted higher. Some evening, that will be you, and you will be extremely glad this is how it works.

## Why the wait can get longer after you arrive

This is the part that feels unfair and is not. Triage is continuous. A hospital can go from calm to overwhelmed in the eleven minutes it takes for two crashes to arrive at once. Your position is not a ticket you hold — it is re-evaluated against whatever just came through the door.

Which is why nobody at the desk will promise you a time. It is not evasiveness. They genuinely do not know, and a number they invent to make you feel better is a number they will have to break.

## What is reasonable to ask

Ask them to reassess if your animal gets worse. Say it plainly: *he''s gotten worse since we checked in, can someone look at him again?* That is not being difficult, that is giving them information they cannot get from the waiting room.

Ask roughly where you sit — "are we likely to be a couple of hours?" is a fair question and usually gets a fair answer.

Ask whether you can step out. Sometimes yes, sometimes absolutely not, and the answer tells you something about how they have sorted you.

## Where we fit

Tími does nothing to your position in triage. It cannot and it should not — that judgment belongs to the people who can see the animal. What it does is earlier and narrower: it tells you which hospitals can take a patient at all, before you pick one. Once you are through the door, the hospital''s own judgment is the only thing that matters, and we say so on the screen where you choose rather than in a footnote.',
  'published',
  datetime('now', '-3 minutes'),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO blog_posts (
  id, slug, author_kind, tenant_id, author_user_id, author_name, provider_name,
  title, excerpt, body_markdown, status, published_at, created_at, updated_at
) VALUES (
  'post_seed04',
  'how-to-talk-to-a-vet-about-money',
  'platform',
  NULL,
  NULL,
  NULL,
  NULL,
  'How to talk to a vet about money, before the treatment starts',
  'One sentence at the beginning changes what the rest of the night costs. Plus better questions than “how much will this be?”',
  'The worst version of this conversation happens at the front desk at the end, with a printed invoice and a card that will not cover it. Everyone involved hates that version. It is also almost entirely avoidable, and the thing that avoids it is a sentence you say at the beginning.

## Say it before anything starts

> "I need to tell you upfront that money is tight. Can you help me understand what things cost as we go?"

That is it. Say it to the nurse at check-in, and say it again to the veterinarian when they come in.

Here is what that sentence actually does. A veterinary team has, for almost any presentation, a range of approaches — the thorough one, the targeted one, and the one that stabilizes the animal now and defers what can be deferred. They default to thorough because that is good medicine and because most people, asked nothing, want everything. Told about a constraint, they will work inside it. Told nothing until checkout, they cannot.

## Better questions than "how much will this cost?"

That question gets you an estimate and a flinch. These get you options:

- **"What is the least expensive way to find out what''s wrong?"** Diagnostics have tiers. Sometimes one test answers the question three would have.
- **"What has to happen tonight, and what could wait until Monday?"** Some things genuinely cannot wait. Many can, and the answer separates them.
- **"Can we do this in stages, and decide after each one?"** Usually yes.
- **"Is there a generic, or a cheaper formulation?"** Often, and nobody offers it unprompted.
- **"Can I get a written estimate before you start?"** You are entitled to this. Ask for it.

## Things worth knowing before the night you need them

**Medical credit** — CareCredit and similar — is the thing most clinics will point you toward. Approval is instant and it is genuine credit, so read the promotional-period terms, because deferred interest is real and it lands all at once if you miss the window.

**Teaching hospitals.** If you are near a veterinary school, their emergency service is often meaningfully cheaper, with the tradeoff of longer waits and being seen by students under supervision.

**Humane society and nonprofit clinics.** Many run low-cost services with income eligibility. Not usually emergency care, but the place to know about for everything that comes after.

**Ask the clinic what they have seen work.** Veterinary staff deal with this every week. They know the local landscape better than any article does, including this one.

## What we cover, which is small

The [Paw It Forward Fund](/help-with-vet-bills) covers Tími''s own access fee for people whose hardship has been verified — the fee we would otherwise charge. It does not pay for treatment, medication, or a clinic''s deposit, and we will not pretend otherwise. It is the part we control, so it is the part we give away. The bill from the hospital is a much bigger number and it is not ours to waive.

---

None of this is a reason to wait. If your animal needs care tonight, go tonight, and have the conversation about money at the beginning rather than the end.',
  'published',
  datetime('now', '-2 minutes'),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO blog_posts (
  id, slug, author_kind, tenant_id, author_user_id, author_name, provider_name,
  title, excerpt, body_markdown, status, published_at, created_at, updated_at
) VALUES (
  'post_seed05',
  'what-to-take-to-the-emergency-vet',
  'platform',
  NULL,
  NULL,
  NULL,
  NULL,
  'What to take to the emergency vet',
  'Nobody packs a bag for this. If you have five minutes, here is the short list that makes the next few hours easier.',
  'Nobody packs a bag for this. You grab the dog and the keys and you go, which is correct — if it is bad, go, and read this some other time.

But if you have five minutes, or if you are reading this on a Tuesday when nothing is wrong, there is a short list that makes the next few hours meaningfully easier.

## The five-minute version

**A photo of every medication label.** Front of the bottle, where the drug name and strength are. This includes the flea and tick treatment, the joint supplement, the ear drops from March, and anything anybody else in the house gave him. Half the guesswork in an emergency exam is pharmacological, and a photo removes it.

**Whatever came out, if something came out.** Vomit, diarrhea, the thing he coughed up. In a bag, in a container, on a paper towel. It is grim and it is diagnostic. Same for the packaging of whatever he ate, which tells them the active ingredient and the concentration, and those two facts can be the entire conversation.

**A carrier for a cat, not a towel.** A frightened cat in a waiting room full of dogs will get out of your arms. This is not hypothetical; it happens at every emergency hospital, regularly.

**Your phone charger.** You will be there longer than you think and your phone is where the photos, the payment, and the person you need to call all live.

**Something to sit on the floor with.** A hoodie. Waiting rooms are cold and the chairs fill up.

## The things that are information, not objects

Have these ready to say:

- Roughly what he weighs. Doses are weight-based.
- When it started, in hours.
- Whether he is neutered or spayed.
- Whether he has eaten today, and when.
- Any chronic conditions and any prior surgeries.
- Your regular vet''s name, so records can be requested.

If you keep pets, put that in a note on your phone now and update it twice a year. The version of you who needs it will not be composing it from memory at midnight.

## What not to bother with

Do not stop to bathe him. Do not try to make him vomit unless a veterinarian or a poison line has told you to on that specific substance — for some of them it makes the injury worse coming back up. Do not spend twenty minutes reading forums to decide whether it is serious enough; if you are on your third search, you have already answered that.

---

Tími can tell you which hospitals near you have said they can take a patient right now, which saves the part of this where you call four places. It cannot tell you whether to go. If you are asking, go.',
  'published',
  datetime('now', '-1 minutes'),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO blog_posts (
  id, slug, author_kind, tenant_id, author_user_id, author_name, provider_name,
  title, excerpt, body_markdown, status, published_at, created_at, updated_at
) VALUES (
  'post_seed06',
  'why-we-show-you-the-time-a-clinic-said-it',
  'platform',
  NULL,
  NULL,
  NULL,
  NULL,
  'Why we show you the time a clinic said it',
  'A padded directory does not fail when you read it. It fails forty minutes later, in a parking lot.',
  'Every clinic on Tími shows the time it last reported its status. Not "recently." Not a freshness dot. The actual time, right there next to the result, and if the report has gone stale we stop showing the clinic as available rather than quietly aging the number.

That decision cost us something, and I would make it again.

## What it costs

A directory looks better full. If we showed every clinic in your area with a plausible-looking status, our results page would be dense and confident and would feel, at a glance, like a more complete product than it is.

Ours is sometimes short. On a slow night in a thin market it can be very short, and occasionally it says nobody nearby is reporting capacity right now, which is a terrible thing for a screen to say to somebody holding a sick animal.

We say it anyway, because the alternative is worse in a specific way. A padded list does not fail at the moment you read it. It fails forty minutes later, in a parking lot, when the hospital that your phone said was available turns out to have been full since seven.

## Why a timestamp and not a freshness indicator

We went around on this. A colored dot — green for fresh, amber for aging — is prettier, and it is the standard pattern, and we built it first.

The problem is that a dot is our judgment presented as fact. Fresh according to whom? Five minutes is fresh at 2am on a Saturday and nearly meaningless at 6pm on a Monday in a hospital that turns over fast. We do not know your situation, how far you are willing to drive, or how much risk you are carrying. You do.

So we give you the input instead of the conclusion. "Reported 4 minutes ago" is a fact you can weigh. "Fresh" is us deciding for you and being wrong some of the time without telling you which times.

## Why clinics answer honestly

This only works if a front desk that is already underwater tells us the truth, and the way you get truth is by making the honest answer free.

A clinic that reports it cannot take a patient pays us nothing and receives no requests. There is no penalty, no ranking consequence, no nudge. Saying *no, not tonight* costs a clinic exactly nothing, which is the only arrangement under which anyone says it at eleven o''clock while the phone is ringing.

If we charged for listings, or ranked by anything other than what a clinic actually reported, that would stop being true immediately, and the number next to the timestamp would become marketing.

## The number we will not show you

We do not estimate wait times ourselves. Clinics report a range for a stable patient, and we pass it through as theirs, because a wait is a product of triage and triage is a clinical judgment we are not qualified to model. Anyone showing you a confident minutes-until-seen figure for an emergency hospital has built a model of something that is not modelable.

---

If you want to see what this looks like when it is working, [find care near you](/#find). If it comes back thin, that is the honest answer for your area tonight, and we would rather hand you a small true thing than a large invented one.',
  'published',
  datetime('now', '-0 minutes'),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
