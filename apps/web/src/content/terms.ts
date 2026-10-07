import type { Doc } from "@/lib/doc";
import { p } from "@/lib/doc";
import { siteConfig } from "@/lib/site-config";

/**
 * The Terms of Use, on General Legal's website terms of use template with its
 * JAMS arbitration option. Sections 1–11 keep the template's numbers so its
 * cross-references hold; what is specific to Vibedgames (your games, the
 * rules for what you deploy, generation credits, the open-source code) sits in
 * Section 2 from 2.7 on, carried over from the terms these replace.
 *
 * Rendered as HTML by `components/legal/legal-page` and served verbatim as
 * markdown, so there is no second copy to keep in step.
 */

const { email, name: operator } = siteConfig.operator;
const mail = `[${email}](mailto:${email})`;

export const termsDoc: Doc = {
  description:
    "The terms for using Vibedgames — vibedgames.com, the games it hosts, the vg CLI and the agent skills — including the rules for what you deploy, generation credits and how disputes are resolved.",
  endnote: [
    p(
      "This template was prepared and made publicly available by General Legal, PC (“General Legal”). It is provided for general reference purposes only and does not constitute, and should not be construed as, legal advice, or an endorsement or review of any particular transaction in which it is used. Use of this template does not create an attorney-client relationship with General Legal. General Legal has not reviewed, and takes no position on, any modifications made to this document or the deal terms it is used to document.",
    ),
  ],
  lead: [
    p("**Version 2.0 Last revised:** October 7, 2026"),
    p(
      `The website located at vibedgames.com, together with the game hosting at \`{slug}.vibedgames.com\`, the multiplayer servers, the API, the \`vg\` command-line tool and the vibedgames agent skills and plugin (collectively, the “**Site**”) is owned and operated by ${operator} (“**Vibedgames**,” “**us**,” “**our**,” or “**we**”). Certain features of the Site may be subject to additional guidelines or rules posted on the Site, which are incorporated by reference into these Terms.`,
    ),
    p(
      "These Terms of Use (“**Terms**”) govern your use of the Site. By accessing or using the Site, or by clicking “I agree” (or a similar button or checkbox) when that option is presented to you, you agree to these Terms on behalf of yourself or the entity you represent, and you confirm that you have the authority to do so. You must be at least 13 years old to use the Site. If you are under 18 (or the age of majority where you live), you may use the Site only with the permission and involvement of a parent or legal guardian, who agrees to these Terms on your behalf. If you do not agree to these Terms, please do not use the Site.",
    ),
    p(
      "**IMPORTANT – PLEASE READ SECTION 11 CAREFULLY.** It contains an agreement to resolve disputes through binding individual arbitration instead of in court, and includes a waiver of class action rights and jury trial rights. You have 30 days to opt out of the arbitration agreement, as further described in Section 11.",
    ),
  ],
  path: "/terms",
  sections: [
    {
      blocks: [
        p(
          `1.1 **Creating an Account.** Some features of the Site may require you to register for an account. When you register, you agree to provide accurate and complete information and to keep that information current. You can delete your account at any time by emailing us at ${mail} from the email address on your account. We may suspend or terminate your account as described in Section 8.`,
        ),
        p(
          "1.2 **Account Security.** You are responsible for keeping your login credentials confidential and for all activity that occurs under your account. Your login credentials include your password, the login the `vg` CLI saves on your computer and any API keys you create; revoke a key as soon as you think it has leaked. If you believe your account has been accessed without your authorization, please notify us immediately. We are not liable for any losses resulting from your failure to keep your credentials secure.",
        ),
      ],
      heading: "1. Accounts",
    },
    {
      blocks: [
        p(
          "2.1 **License.** Subject to these Terms, we grant you a limited, non-exclusive, non-transferable, revocable license to access and use the Site for your personal or internal business purposes.",
        ),
        p(
          "2.2 **Restrictions.** You may not: (i) license, sell, rent, lease, transfer, assign, distribute, or commercially exploit the Site or any content on it; (ii) modify, create derivative works from, disassemble, reverse-compile, or reverse-engineer any part of the Site; (iii) access the Site in order to build a similar or competing product or service; or (iv) copy, reproduce, distribute, republish, download, display, post, or transmit any part of the Site except as expressly permitted by these Terms. All copyright and proprietary notices on the Site must be kept intact on any copies you are permitted to make.",
        ),
        p(
          "2.3 **Changes to the Site.** We may modify, suspend, or discontinue the Site (or any part of it) at any time, with or without notice. We are not liable to you or any third party for any such modification, suspension, or discontinuation.",
        ),
        p(
          "2.4 **No Support Obligation.** We have no obligation to provide you with support or maintenance for the Site.",
        ),
        p(
          "2.5 **Ownership.** All intellectual property rights in the Site and its content — including copyrights, patents, trademarks, and trade secrets — belong to Vibedgames or its suppliers, except Your Content and what other users deploy (Section 2.7). These Terms do not transfer any ownership rights to you, except for the limited access rights in Section 2.1. All rights not expressly granted are reserved.",
        ),
        p(
          "2.6 **Feedback.** If you share feedback or suggestions about the Site with us, you grant us a perpetual, irrevocable, worldwide, non-exclusive, fully-paid, royalty-free license to use that feedback freely, in any manner and for any purpose, without attribution. Please do not submit any feedback that you consider proprietary or confidential.",
        ),
        p(
          "2.7 **Your Content.** You keep any ownership you have in the games, source code and other content you deploy, upload or generate through the Site (“**Your Content**”). You grant us a worldwide, non-exclusive, royalty-free license to store, copy, serve and display Your Content as needed to operate the Site, which includes showing your game to anyone who visits its address. If you deploy with `--source`, any signed-in user can download, fork and change your project source, and you allow them to do so; only publish source you are willing to share. You are responsible for Your Content, and you must have the rights to everything you deploy.",
        ),
        p(
          "2.8 **Acceptable Use.** You may not use the Site to: (i) host malware, phishing pages or anything that collects credentials or payment details; (ii) publish illegal content, or content that infringes someone else’s rights; (iii) harass, threaten or exploit anyone, especially minors; (iv) attack, overload or probe the Site or other users’ games; or (v) get around generation credits, rate limits or other usage limits. We may remove content or suspend accounts that break these rules, and we may do so without notice.",
        ),
        p(
          "2.9 **Permitted Uses.** As an exception to Section 2.2, you may crawl and index the pages of vibedgames.com, and use them as input to, and for training, artificial intelligence models, to the extent our robots.txt file allows.",
        ),
        p(
          `2.10 **Open-Source Software.** The vibedgames source code, including the \`vg\` CLI, the npm packages and the agent skills, is published under the MIT License at [github.com/kyh/vibedgames](${siteConfig.repository}). Source code that we publish under an open-source license, such as the MIT License, is governed by that license, and nothing in these Terms limits your rights under it. These Terms govern the hosted Site.`,
        ),
        p(
          "2.11 **Generation Credits.** New accounts start with no generation credits. You can buy credits, which our payment processor, Stripe, charges to your card, and we may also grant credits through codes or promotions. Credits are priced in US dollars, are used up at the cost of each generation, have no cash value, cannot be transferred, and do not expire unless we tell you otherwise. Purchases are final and non-refundable except where the law requires otherwise, or where we choose to refund a purchase you have not used. Generation stops when your balance runs out. Generated assets come from third-party AI models. You are responsible for how you use them, and each model’s own terms may also apply.",
        ),
      ],
      heading: "2. Access to the Site",
    },
    {
      blocks: [
        p(
          "Your use of the Site is also governed by our Privacy Policy, which is available at [vibedgames.com/privacy](/privacy) and is incorporated into these Terms by reference. The Privacy Policy describes the types of personal data and other information we collect from you or your device, how we use that information, and the circumstances under which we may share it with third parties.",
        ),
        p(
          "3.1 **Processing of Personal Data.** By using the Site, you acknowledge that you have read and understand our Privacy Policy and that Vibedgames will process your personal data and other information in accordance with the Privacy Policy. If there is a conflict between these Terms and the Privacy Policy with respect to the collection, use, or processing of your personal data, the Privacy Policy will control.",
        ),
        p(
          "3.2 **Cookies and Tracking Technologies.** The Site may use cookies, web beacons, pixels, and similar tracking technologies (“**Tracking Technologies**”) to collect information about your use of the Site. For details on what Tracking Technologies the Site uses, what information they collect, and how you can manage your preferences, please refer to the [Tracking & Other Technologies](/privacy#tracking--other-technologies) section of our Privacy Policy.",
        ),
      ],
      heading: "3. Privacy",
    },
    {
      blocks: [
        p(
          "You agree to defend, indemnify, and hold harmless Vibedgames and its officers, employees, and agents from any claims and reasonable costs or attorneys’ fees arising out of (i) your use of the Site, (ii) your violation of these Terms, or (iii) your violation of any applicable law or regulation. We may assume control of the defense of any such claim at your expense, and you agree to cooperate with our defense. You agree not to settle any such claim without our prior written consent. We will make reasonable efforts to notify you promptly of any claim we become aware of.",
        ),
      ],
      heading: "4. Indemnification",
    },
    {
      blocks: [
        p(
          "5.1 **Third-Party Services.** The Site may include links to or integrations with third-party websites or services (collectively, “**Third-Party Services**”), including the third-party AI models that generate assets and play games in automated playtests through the Site. We do not control, endorse, or take responsibility for any Third-Party Services. You use all Third-Party Services at your own risk, and you acknowledge and agree that the applicable third party’s own terms and privacy practices will apply to such use.",
        ),
        p(
          "5.2 **Other Users.** Your interactions with other users of the Site are solely between you and those users. We are not responsible for any loss or harm resulting from those interactions, and we reserve the right, but have no obligation, to get involved in disputes between users. Games on `{slug}.vibedgames.com` are made by the users who deploy them, not by us (apart from the example games we publish), and may run their own code, collect information or link to other services; you play them at your own risk.",
        ),
        p(
          "5.3 **Release.** To the fullest extent permitted by law, you release Vibedgames and its officers, employees, agents, successors, and assigns from all claims, demands, and damages of any kind arising out of or related to the Site, other users, or Third-Party Services. If you are a California resident, you waive California Civil Code Section 1542, which provides: “A general release does not extend to claims which the creditor or releasing party does not know or suspect to exist in his or her favor at the time of executing the release, which if known by him or her must have materially affected his or her settlement with the debtor or released party.”",
        ),
      ],
      heading: "5. Third-Party Services & Other Users",
    },
    {
      blocks: [
        p(
          "THE SITE IS PROVIDED “AS IS” AND “AS AVAILABLE.” TO THE FULLEST EXTENT PERMITTED BY LAW, VIBEDGAMES AND ITS SUPPLIERS DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SITE WILL BE UNINTERRUPTED, ERROR-FREE, SECURE, OR FREE OF VIRUSES OR HARMFUL CODE. WHERE APPLICABLE LAW REQUIRES WARRANTIES, THEY ARE LIMITED TO 90 DAYS FROM YOUR FIRST USE. WE DO NOT GUARANTEE THAT YOUR DATA OR YOUR GAMES WILL BE PRESERVED, SO KEEP YOUR OWN COPIES OF YOUR GAMES. ASSETS GENERATED THROUGH THE SITE AND THE RESULTS OF AUTOMATED PLAYTESTS ARE PRODUCED BY THIRD-PARTY AI MODELS AND MAY BE INACCURATE OR UNSUITABLE FOR YOUR PURPOSES.",
        ),
      ],
      heading: "6. Disclaimers",
    },
    {
      blocks: [
        p(
          "TO THE MAXIMUM EXTENT PERMITTED BY LAW: (A) VIBEDGAMES AND ITS SUPPLIERS WILL NOT BE LIABLE FOR ANY LOST PROFITS, LOST DATA, COSTS OF SUBSTITUTE PRODUCTS, OR ANY INDIRECT, CONSEQUENTIAL, INCIDENTAL, SPECIAL, EXEMPLARY, OR PUNITIVE DAMAGES ARISING FROM OR RELATED TO THESE TERMS OR YOUR USE OF (OR INABILITY TO USE) THE SITE; AND (B) OUR TOTAL LIABILITY TO YOU FOR ANY CLAIM ARISING UNDER THESE TERMS IS CAPPED AT THE GREATER OF (i) $50 USD AND (ii) THE AMOUNT PAID TO VIBEDGAMES BY YOU UNDER THESE TERMS IN THE SIX MONTHS PRIOR TO THE INCIDENT GIVING RISE TO THE CLAIM. THE EXISTENCE OF MULTIPLE CLAIMS DOES NOT INCREASE THIS CAP.",
        ),
      ],
      heading: "7. Limitation of Liability",
    },
    {
      blocks: [
        p(
          "These Terms remain in effect while you use the Site. We may suspend or terminate your access (including suspending access to or deleting your account) at any time and for any reason, including if we believe you have violated these Terms. We are not liable to you for any such termination. You can stop using the Site at any time. Upon termination, Sections 2.2 through 2.7 and Sections 3 through 11 will survive.",
        ),
      ],
      heading: "8. Term and Termination",
    },
    {
      blocks: [
        p(
          "The provisions in this Section 9 apply only to users to the extent such users are subject to the laws of the applicable states identified below. If a provision in this section conflicts with another provision of these Terms, the state-specific provision controls for users subject to that state’s laws.",
        ),
        p(
          `9.1 **California.** If you are a California resident, you may report complaints to the Complaint Assistance Unit of the Division of Consumer Services of the California Department of Consumer Affairs, at 1625 N. Market Blvd. Suite N112, Sacramento, CA 95834, or by phone at (800) 952-5210. Under California Civil Code Section 1789.3, California users of the Site are entitled to the following specific consumer rights notice: The provider of the Site is ${operator}. To file a complaint regarding the Site, or to receive further information regarding use of the Site, contact us at ${mail}. You may also contact the Complaint Assistance Unit at the address and phone number above. If you are a California resident, you may have additional rights under the California Consumer Privacy Act (as amended by the California Privacy Rights Act), including the right to know what personal information we collect, the right to delete your personal information, the right to correct inaccurate personal information, and the right to opt out of the sale or sharing of your personal information. For details on how to exercise these rights, please see our Privacy Policy at [vibedgames.com/privacy](/privacy).`,
        ),
        p(
          "9.2 **Colorado.** If you are a Colorado resident, you may have additional rights under the Colorado Privacy Act (CPA), including the right to opt out of the processing of your personal data for purposes of targeted advertising, the sale of personal data, and certain profiling. For details, please see our Privacy Policy.",
        ),
        p(
          "9.3 **Connecticut.** If you are a Connecticut resident, you may have additional rights under the Connecticut Data Privacy Act (CTDPA), including rights of access, correction, deletion, and data portability, as well as the right to opt out of the sale of personal data, targeted advertising, and profiling. For details, please see our Privacy Policy.",
        ),
        p(
          "9.4 **Virginia.** If you are a Virginia resident, you may have additional rights under the Virginia Consumer Data Protection Act (VCDPA), including the right to access, correct, delete, and obtain a copy of your personal data, and the right to opt out of the processing of your personal data for targeted advertising, sale, or profiling. For details, please see our Privacy Policy.",
        ),
        p(
          `9.5 **Nevada.** If you are a Nevada resident, you have the right under Nevada Revised Statutes Chapter 603A to direct us not to sell certain information we have collected or will collect about you. To exercise this right, please contact us at ${mail}.`,
        ),
        p(
          "9.6 **Other States.** If you are a resident of another U.S. state with a comprehensive consumer privacy law, such as Texas, Oregon, Montana, Utah, Iowa, Indiana or Tennessee, you may have similar rights under that law. For details, please see our Privacy Policy.",
        ),
      ],
      heading: "9. State-Specific Legal Notices",
    },
    {
      blocks: [
        p(
          "10.1 **Changes to Terms.** We may update these Terms from time to time. If we make material changes, we may notify you by email (at the address on file) or by a prominent notice on the Site. Your continued use of the Site after notice of changes means you accept the updated Terms. Whenever these Terms change, we update the “Last revised” date at the top of this page.",
        ),
        p(
          "10.2 **Governing Law.** These Terms and any dispute arising out of or related to these Terms or the Site will be governed by and construed in accordance with the laws of the State of California, without regard to its conflict-of-law principles. For any claim or dispute not subject to the arbitration provisions in Section 11, you and Vibedgames irrevocably consent to the exclusive jurisdiction and venue of the state and federal courts located in San Francisco County, California. Notwithstanding the foregoing: (a) either party may bring an action in any court of competent jurisdiction for injunctive or other equitable relief to protect its intellectual property rights (including patents, copyrights, trademarks, and trade secrets); and (b) either party may bring an individual action in small claims court for claims within that court’s jurisdictional limits.",
        ),
        p(
          "10.3 **Export.** You agree not to export, re-export, or transfer any technical data or products acquired from the Site in violation of U.S. export control laws or applicable regulations in other countries.",
        ),
        p(
          "10.4 **Electronic Communications.** By using the Site, you consent to receiving communications from us electronically (by email or notices posted on the Site). These electronic communications satisfy any legal requirement for written notice.",
        ),
        p(
          `10.5 **Accessibility.** Vibedgames is committed to making the Site accessible to all users, including individuals with disabilities. We endeavor to conform to the Web Content Accessibility Guidelines (WCAG) 2.1, Level AA, as published by the World Wide Web Consortium (W3C). If you experience any difficulty accessing or navigating the Site, or if you have suggestions for improving accessibility, please contact us at ${mail}. We will make reasonable efforts to address accessibility concerns promptly.`,
        ),
        p(
          "10.6 **Entire Agreement.** These Terms (together with the Privacy Policy and any other policies or guidelines referenced herein) are the entire agreement between you and Vibedgames regarding your use of the Site. If any provision of these Terms is found to be invalid or unenforceable, it will be modified to the minimum extent necessary to be valid, and the remaining provisions will continue in effect. Our failure to enforce any provision is not a waiver of that provision. The word “including” means “including without limitation.” You may not assign these Terms without our prior written consent; we may assign them freely. These Terms bind any permitted assignees.",
        ),
        p(
          `10.7 **Copyright/Trademark.** Copyright © 2026 ${operator}. All rights reserved. All trademarks, logos, and service marks displayed on the Site are owned by Vibedgames or third parties. You may not use any of them without prior written consent from the owner. Open-source code is licensed as described in Section 2.10.`,
        ),
        p(
          `10.8 **Contact Information:** ${mail}. You can also ask questions about the Site in [GitHub issues](${siteConfig.issues}); they are public, so leave personal information out of them.`,
        ),
      ],
      heading: "10. General",
    },
    {
      blocks: [
        p(
          "**Please read this section carefully. It affects your legal rights, including your right to sue in court and your right to a jury trial.**",
        ),
        p(
          "11.1 **Applicability.** Except as described below, you and Vibedgames agree to resolve all disputes arising out of or relating to the Site, its services, or these Terms through binding individual arbitration — not in court. Exceptions include: (i) claims that qualify for small claims court, brought on an individual basis; and (ii) requests for equitable relief related to intellectual property (such as trademarks, trade secrets, or copyrights). This arbitration agreement applies to all claims, including those that arose before you agreed to these Terms.",
        ),
        p(
          `11.2 **Try to Resolve First.** Before starting arbitration, the parties agree to try to resolve the dispute informally. The party raising the dispute must send written notice (an “**Informal Notice**”) to the other party. Within 45 days of receiving that Informal Notice, the parties will meet by phone or video in good faith to try to work things out. Our notice address is ${mail}. If the informal dispute resolution process doesn’t resolve the dispute within 60 days, either party may start arbitration.`,
        ),
        p(
          "11.3 **Arbitration Rules.** Arbitrations will be administered by JAMS (www.jamsadr.com). Claims under $250,000 (excluding fees and interest) will use JAMS’ Streamlined Arbitration Rules; larger claims will use JAMS’ Comprehensive Arbitration Rules. Unless the parties agree otherwise, arbitration will be conducted in the county where you live. All arbitration materials and documents are confidential.",
        ),
        p(
          "11.4 **Arbitration Request.** The arbitration request must include: (i) your contact information and account username (if applicable); (ii) a description of the claims and supporting facts; (iii) the relief you’re seeking and a good-faith damages estimate; (iv) confirmation that you completed the informal resolution process; and (v) proof of any required filing fee payment.",
        ),
        p(
          "11.5 **Authority of Arbitrator.** The arbitrator has authority to resolve all arbitrable disputes, including questions about the scope and enforceability of this arbitration agreement — except that courts (not arbitrators) will decide: (i) challenges to the class action waiver below; (ii) disputes about arbitration fees; (iii) whether a condition precedent to arbitration has been satisfied; and (iv) which version of this agreement applies. The arbitrator may award the same relief as a court, but on an individual basis only. The arbitrator’s award is final and binding, and judgment may be entered in any court with jurisdiction.",
        ),
        p(
          "11.6 **Waiver of Jury Trial.** BY AGREEING TO ARBITRATION, YOU AND VIBEDGAMES WAIVE THE RIGHT TO A TRIAL BY JUDGE OR JURY FOR ALL COVERED CLAIMS.",
        ),
        p(
          "11.7 **Waiver of Class Actions.** ALL DISPUTES MUST BE BROUGHT ON AN INDIVIDUAL BASIS. NEITHER YOU NOR VIBEDGAMES MAY BRING CLAIMS AS A PLAINTIFF OR CLASS MEMBER IN ANY CLASS, REPRESENTATIVE, OR COLLECTIVE PROCEEDING. The arbitrator may only award relief on an individual basis. If a court finds this class action waiver unenforceable as to a specific claim, that claim may be litigated in state or federal court in San Francisco County, California; all other claims remain subject to arbitration.",
        ),
        p(
          "11.8 **Attorneys’ Fees.** Each party bears its own attorneys’ fees unless the arbitrator finds a claim was frivolous or brought for an improper purpose.",
        ),
        p(
          "11.9 **Batch Arbitration.** If 100 or more substantially similar arbitration demands are filed against Vibedgames within a 30-day period by the same law firm or coordinated group, JAMS will batch them into groups of 100 and appoint one arbitrator per batch, with one set of fees per batch.",
        ),
        p(
          `11.10 **Opt-Out.** You may opt out of this arbitration agreement within 30 days of first accepting these Terms by sending written notice to ${mail}. Your notice must include your name, the email address you use with the Site, and a clear statement that you wish to opt out. Opting out does not affect any other part of these Terms.`,
        ),
        p(
          "11.11 **Severability.** If any part of this arbitration agreement is found invalid, it will be modified to the minimum extent necessary to make it enforceable; the rest of the agreement remains in effect.",
        ),
      ],
      heading: "11. Dispute Resolution",
    },
  ],
  title: "Terms of Use",
};
