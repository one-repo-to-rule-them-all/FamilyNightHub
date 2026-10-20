import type { Metadata } from "next";
import Link from "next/link";

import { OPERATOR_CONTACT, TERMS_VERSION } from "@/lib/legal";

import { LegalPage } from "../legal-page";

export const metadata: Metadata = { title: "Terms" };

/** ADR-0017 §3. Bump TERMS_VERSION (here and in the backend) on a material change. */
export default function TermsPage() {
  return (
    <LegalPage title="Terms" version={TERMS_VERSION}>
      <p>
        Family Night is a private service run by its operator for families they invite. By accepting
        these terms you agree to the following, and to the{" "}
        <Link className="underline" href="/legal/privacy">
          Privacy Policy
        </Link>
        .
      </p>

      <section>
        <h2>Who can use it</h2>
        <ul>
          <li>
            Households exist only by invitation from the operator. There is no public sign-up.
          </li>
          <li>
            A household&apos;s admins are adults. An admin confirms they are a parent or legal
            guardian of every child they add, and that they supervise those children&apos;s use.
          </li>
          <li>
            Guests at a movie night join with that night&apos;s code. Their profile is a guest
            profile an admin can remove.
          </li>
        </ul>
      </section>

      <section>
        <h2>Your household&apos;s content</h2>
        <ul>
          <li>
            You keep everything you add. Only add photos you have the right to share with your
            household.
          </li>
          <li>Nothing unlawful, and nothing that harms a child.</li>
          <li>
            You can download your household&apos;s data, or delete it, at any time (see the Privacy
            Policy).
          </li>
        </ul>
      </section>

      <section>
        <h2>The operator</h2>
        <ul>
          <li>
            The operator can open your household to help with a problem. Each time is logged and
            shown to your admins.
          </li>
          <li>
            The operator can switch a household off (nothing is deleted) if these terms are broken,
            and will say why.
          </li>
          <li>
            The service is provided as it is, without a guarantee that it is always available. Keep
            your own copies of photos that matter.
          </li>
        </ul>
      </section>

      <section>
        <h2>Changes and contact</h2>
        <p>
          When these terms change in a way that matters, their version changes and every account is
          asked to accept them again. Write to{" "}
          <a className="underline" href={`mailto:${OPERATOR_CONTACT}`}>
            {OPERATOR_CONTACT}
          </a>{" "}
          with any question.
        </p>
      </section>
    </LegalPage>
  );
}
