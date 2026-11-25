import type { Metadata } from "next";

import { OPERATOR_CONTACT, PRIVACY_VERSION } from "@/lib/legal";

import { LegalPage } from "../legal-page";

export const metadata: Metadata = { title: "Privacy Policy" };

/** ADR-0017 §3: every item the ADR requires, in plain words. Bump PRIVACY_VERSION on a change. */
export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" version={PRIVACY_VERSION}>
      <p>
        Family Night is a private, invite-only app for running movie nights at home. This page says
        what it stores, who can see it, and how to get it back or have it deleted.
      </p>

      <section>
        <h2>What we store</h2>
        <ul>
          <li>
            <strong>Adults with an account</strong> (admins and hosts): email, display name,
            optional username, and a one-way hash of the password. Nobody, the operator included,
            can read the password.
          </li>
          <li>
            <strong>Everyone in the household, children included</strong>: a first name, an emoji, a
            color, and a one-way hash of their 6-digit PIN.
          </li>
          <li>
            <strong>Phones and the TV</strong>: an optional label, when each was last used, and a
            hash of its sign-in cookie.
          </li>
          <li>
            <strong>Movie nights</strong>: the movies on the shortlist, each person&apos;s votes and
            ratings, who was there, and the winner.
          </li>
          <li>
            <strong>Photos</strong> dropped into a night, the date they were taken, and who added
            them. Location data is stripped on the phone before upload.
          </li>
          <li>
            <strong>An activity log</strong> of changes (who joined, who was added, what was
            deleted) so the household&apos;s admins can see what happened.
          </li>
        </ul>
      </section>

      <section>
        <h2>Who can see it</h2>
        <ul>
          <li>
            Members of your household see your household&apos;s nights and photos. Admins also see
            people, phones and settings. No other household can see anything of yours.
          </li>
          <li>
            <strong>The operator</strong>, who runs this service, can open your household to help
            with a problem. Every time they do, it is logged, and your admins see it in the activity
            log. They can&apos;t see passwords or PINs.
          </li>
        </ul>
      </section>

      <section>
        <h2>Where it lives</h2>
        <p>
          The app and its database run on Fly.io. Photos are stored with Tigris. Emails (invites and
          password resets) go through an email provider. Error reports go to Sentry with no family
          content. Movie details come from TMDB, which never receives anything about your family.
          Your data is never sold or used for advertising or to train AI.
        </p>
      </section>

      <section>
        <h2>Children</h2>
        <p>
          A household&apos;s first admin confirms they are a parent or legal guardian of the
          children they add, and accepts these terms for them before any child can be added.
          Children use the app on a phone their parent or guardian lets in, under that adult&apos;s
          supervision.
        </p>
      </section>

      <section>
        <h2>Keeping and deleting</h2>
        <ul>
          <li>
            An admin can download everything the household holds, photos included, at any time.
          </li>
          <li>An admin can delete a person, or a photo, from the app.</li>
          <li>
            An admin can delete the whole household. After a 7-day wait (which they can cancel),
            everything is removed from the live service. Backups age out within 60 days.
          </li>
          <li>
            A household that is switched off keeps its data until it is deleted. Its admins get a
            reminder after 12 months.
          </li>
        </ul>
      </section>

      <section>
        <h2>Changes and contact</h2>
        <p>
          When this policy changes in a way that matters, its version changes and every account is
          asked to accept it again. Questions, or a deletion you can&apos;t do from the app: write
          to <a href={`mailto:${OPERATOR_CONTACT}`}>{OPERATOR_CONTACT}</a>.
        </p>
      </section>
    </LegalPage>
  );
}
