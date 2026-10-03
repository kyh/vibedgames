import type { Doc, Section } from "@/lib/doc";
import { headingId, p, table, ul } from "@/lib/doc";
import { siteConfig } from "@/lib/site-config";

/**
 * The Privacy Policy, on General Legal's GDPR-enhanced privacy policy
 * template: its sections, its defined terms and its wording, kept only where
 * true of Vibedgames. Every fact here is checked against the code that does
 * it — the auth config, the schema, the routers, the CLI — so a change to what
 * the platform collects, keeps or sends changes this file in the same commit.
 *
 * Rendered as HTML by `components/legal/legal-page` and served verbatim as
 * markdown, so there is no second copy to keep in step.
 */

const { email, name: operator } = siteConfig.operator;
const mail = `[${email}](mailto:${email})`;

/** Top-level headings, named once so the Index and every cross-reference land on them. */
const H = {
  changes: "Changes to this Privacy Policy",
  children: "Children",
  choices: "Your choices",
  collect: "Personal information we collect",
  contact: "How to contact us",
  europe: "Notice to European users",
  other: "Other sites and services",
  retention: "Retention",
  security: "Security",
  share: "How we share your personal information",
  state: "State privacy rights notice",
  tracking: "Tracking & Other Technologies",
  transfer: "International data transfer",
  use: "How we use your personal information",
} as const;

const link = (heading: string, label: string = heading) => `[${label}](#${headingId(heading)})`;

/** Who we may disclose a category to, for the CCPA table. */
const DISCLOSED_TO =
  "Service providers; Professional advisors; Authorities and others; Business transferees";
const OPERATIONS = "Service delivery and operations; Compliance and protection";

const sections: Section[] = [
  {
    blocks: [
      p(
        "**Information you provide to us.** Personal information you may provide to us through the Service or otherwise includes:",
      ),
      ul(
        "**Contact data**, such as your name and email address.",
        "**Profile data**, such as the password that you set to establish an online account on the Service (we store only a hash of it), the invite code you signed up with, and the API keys you create for the CLI and CI and their names (we store only a hash of each key and its first few characters, so you can tell your keys apart).",
        "**Communications data** based on our exchanges with you, including when you email us, contact us through GitHub or social media, or otherwise.",
        "**Transactional data**, such as the history of your generation credit balance: the credits granted to your account and, for each asset-generation request, the model used, the provider’s request identifier, its status and what it cost. This is how we keep your credit balance.",
        "**Marketing data**, such as the email address you give us to join the waitlist (and a link to your account, if you are signed in when you join).",
        "**User-generated content and input data**, such as the games you deploy (their files, name and slug) and, if you deploy with `--source`, your project source (without the files your `.gitignore` or `.vibedgamesignore` excludes, or secret files such as `.env`); the prompts, settings and input files you send to generate assets with `vg generate`; the snapshots of a game’s state, and the questions about it, that `vg playtest run` sends while a model plays the game; and the messages multiplayer games send between players, as well as associated metadata. Metadata includes information on how, when and by whom a piece of content was collected and how that content has been formatted, such as when a game was deployed and each deployed file’s path, type, size and checksum.",
        "**Other data** not specifically listed here, which we will use as described in this Privacy Policy or as otherwise disclosed at the time of collection.",
      ),
      p(
        "**Third-party sources.** We may combine personal information we receive from you with personal information falling within one of the categories identified above that we obtain from other sources, such as:",
      ),
      ul(
        "**Service providers** that provide services on our behalf or help us operate the Service or our business, such as the AI model provider that reports how much each of your generation requests used, which we record as its cost.",
      ),
      p(
        "**Automatic data collection.** We and our service providers may automatically log information about you, your computer or mobile device, and your interaction over time with the Service, such as:",
      ),
      ul(
        "**Device data**, such as your IP address and your browser’s or device’s user agent (which identifies its type and version). We store both with each signed-in session, and we count requests from each IP address to rate-limit sign-in and other account requests.",
        "**Online activity data**, such as the pages and API requests you make to the Service and when you make them, which our hosting provider records in server logs, and when each of your API keys was last used.",
      ),
      p(
        `For more information concerning our automatic collection of data, please see the ${link(H.tracking)} section below.`,
      ),
    ],
    heading: H.collect,
  },
  {
    blocks: [
      p(
        "**Cookies and other technologies.** Some of our automatic data collection is facilitated by cookies and other technologies. The Service uses these:",
      ),
      ul(
        "**Essential.** One first-party cookie, set by us on vibedgames.com, keeps you signed in to the web app. It is never sent to the game subdomains, so games cannot read it, and it expires when you sign out or after at most seven days without use. Our hosting provider, Cloudflare, may also set its own security cookies on vibedgames.com, for example when you pass one of its security checks. Similarly, the `vg` CLI saves your login in a file on your computer (`~/.config/vg/auth.json`), which `vg logout` deletes.",
        "**Functionality / performance.** Some games save data in your browser’s web storage on their own subdomain: for example, the example games we publish remember your best score and your sound settings there. That data stays in your browser, and we do not receive it.",
      ),
      p(
        "We do not use analytics, advertising or social media cookies, web beacons or other tracking technologies.",
      ),
      p(
        "**Chat and other artificial intelligence (“AI”) technologies**, such as those provided by third-party AI model providers, that generate assets and play games to operate the asset-generation and automated-playtest features that you can use to create images, video, audio and 3D models with `vg generate`, and to have a model play your game with `vg playtest run`, through the Service. These AI model providers and other third parties may access and use your prompts, the settings and files you submit for generation, the files the models generate, and the game-state snapshots and questions a playtest sends, to facilitate the provision of the Service.",
      ),
      p(
        "Our generation provider passes each request on to the model you choose, which another company may operate. The files you upload for generation go directly from your computer to that provider’s storage, and the provider hosts them, and the files it generates, under its own terms and retention policies.",
      ),
      p(
        "Some of the example games we publish also offer camera controls, which use on-device machine-learning models to follow your face, hands or body. If you allow camera access, the video is analyzed in your browser and is not sent to us or to anyone else; when you turn the feature on, the game downloads the model it needs from its own subdomain or from a third-party content delivery network.",
      ),
      p(
        `For information concerning your choices with respect to the use of tracking technologies, see the ${link(H.choices)} section below.`,
      ),
    ],
    heading: H.tracking,
  },
  {
    blocks: [
      p(
        "We may use your personal information for the following purposes or as otherwise described at the time of collection:",
      ),
      p("**Service delivery and operations.** We may use your personal information to:"),
      ul(
        "provide the Service, such as by serving the games you deploy and passing your generation and playtest requests to AI model providers;",
        "keep your generation credit balance, by recording what each generation request costs;",
        "enable security features of the Service, such as signing you in, verifying your API keys and rate-limiting sign-in attempts;",
        "establish and maintain your user profile on the Service;",
        "facilitate social features of the Service, such as relaying messages between the players of a multiplayer game and letting other signed-in users fork a game you deploy with its source;",
        "communicate with you about the Service, including by sending Service-related announcements, updates, security alerts, and support and administrative messages; and",
        "provide support for the Service, and respond to your requests, questions and feedback.",
      ),
      p(
        "**Marketing and advertising.** We may collect and use your personal information for marketing purposes:",
      ),
      ul(
        `**Direct marketing.** We may send you direct marketing communications, such as an email to let you know when you can sign up if you joined the waitlist. You may opt out of our marketing communications as described in the ${link(H.choices, "Opt-out of communications")} section below.`,
      ),
      p("**Compliance and protection.** We may use your personal information to:"),
      ul(
        "comply with applicable laws, lawful requests, and legal process, such as to respond to subpoenas, investigations or requests from government authorities;",
        "protect our, your or others’ rights, privacy, safety or property (including by making and defending legal claims);",
        "audit our internal processes for compliance with legal and contractual requirements or our internal policies;",
        "enforce the terms and conditions that govern the Service, including our [Terms of Use](/terms); and",
        "prevent, identify, investigate and deter fraudulent, harmful, unauthorized, unethical or illegal activity, including cyberattacks and identity theft.",
      ),
      p(
        `**Data sharing in the context of corporate events**, we may share certain personal information in the context of actual or prospective corporate events — for more information, see ${link(H.share)}, below.`,
      ),
      p(
        "**To create aggregated, de-identified and/or anonymized data.** We may create aggregated, de-identified and/or anonymized data from your personal information and other individuals whose personal information we collect. We make personal information into de-identified and/or anonymized data by removing information that makes the data identifiable to you and we will not attempt to reidentify any such data. We may use this aggregated, de-identified and/or anonymized data and share it with third parties for our lawful business purposes, including analyzing and improving the Service and promoting our business.",
      ),
      p(
        "**Further uses**, in some cases, we may use your personal information for further uses, in which case we will ask for your consent to use your personal information for those further purposes if they are not compatible with the initial purpose for which information was collected.",
      ),
    ],
    heading: H.use,
  },
  {
    blocks: [
      p(
        "We generally retain personal information to fulfill the purposes for which we collected it, including for the purposes of satisfying any legal, accounting, or reporting requirements, establishing or defending legal claims, or for fraud prevention purposes. To determine the appropriate retention period for personal information, we may consider factors such as the amount, nature, and sensitivity of the personal information, the potential risk of harm from unauthorized use or disclosure of your personal information, the purposes for which we process your personal information and whether we can achieve those purposes through other means, and the applicable legal requirements.",
      ),
      p(
        "When we no longer require the personal information we have collected about you, we may either delete it, anonymize it, or isolate it from further processing.",
      ),
      p("Specifically:"),
      ul(
        "Account data stays until your account is deleted.",
        "Credit and generation records stay with your account.",
        "Signing out of the web app deletes that session’s record, including its IP address and user agent. A session also expires after at most seven days without use.",
        "The per-IP counters we keep to rate-limit sign-in and other account requests each cover a minute or less, and expired counters are deleted as new requests come in.",
        "Revoking an API key deletes it.",
        "Each game keeps only its current deployment: a new deploy replaces the old files and any source, and deleting a game deletes its files, its source and its records. Players’ browsers may keep copies of the files of games they have played.",
        "We do not store your prompts, the files you upload for generation or the files generated for you; the AI model provider that handles a request keeps those files under its own retention policies. We pass playtest snapshots on to the AI model provider and do not keep them.",
        "We relay multiplayer messages without storing them. A room’s game state is held in memory only while players are in the room, and if a player’s connection drops we hold their seat and last state for 30 seconds so they can rejoin.",
        "Waitlist entries stay until you ask us to remove them.",
      ),
    ],
    heading: H.retention,
  },
  {
    blocks: [
      p(
        "We may share your personal information with the following parties (or as otherwise described in this Privacy Policy, in other applicable notices, or at the time of collection). We do not sell your personal information or share it with advertisers, and we do not show ads.",
      ),
      p(
        "**Service providers.** Third parties that provide services on our behalf or help us operate the Service or our business (such as hosting, AI providers and the provider of our email inbox), including:",
      ),
      ul(
        "**Cloudflare**, which hosts the site, the games, the database, file storage and the multiplayer servers.",
        "**AI model providers**, which receive the prompts, inputs and game state described above, and only when you run a command that needs them.",
      ),
      p(
        "**Third parties designated by you.** We may share your personal information with third parties where you have instructed us or provided your consent to do so.",
      ),
      p(
        "**Professional advisors.** Professional advisors, such as lawyers, auditors, bankers and insurers, in the course of the professional services that they render to us.",
      ),
      p(
        "**Authorities and others.** Law enforcement, government authorities, and private parties, as we believe in good faith to be necessary or appropriate for the Compliance and protection purposes described above.",
      ),
      p(
        "**Business transferees.** We may disclose personal information in the context of actual or prospective business transactions (e.g., investments in Vibedgames, financing of Vibedgames, or the sale, transfer or merger of all or part of Vibedgames or its assets). For example, we may need to share certain personal information with prospective counterparties and their advisers. We may also disclose your personal information to an acquirer, successor, or assignee of Vibedgames as part of any merger, acquisition, sale of assets, or similar transaction, and/or in the event of an insolvency, bankruptcy, or receivership in which personal information is transferred to one or more third parties as one of our business assets.",
      ),
      p(
        "**Other users and the public.** Your games and other user-generated content and input data are visible to other users of the Service and the public as follows: anyone who visits a game’s address can play it, download its files and see its name; if you deploy with `--source`, any signed-in user can download and fork your project source; and the other players in a multiplayer room receive the messages your game sends. We do not show your account’s name or email address to other users. This information can be seen, collected and used by others, including being cached, copied, screen captured or stored elsewhere by others (e.g., search engines), and we are not responsible for any such use of this information.",
      ),
    ],
    heading: H.share,
  },
  {
    blocks: [
      p(
        "In this section, we describe the rights and choices available to all users. Users who are located in certain U.S. states and Europe can find additional information about their rights below.",
      ),
      p(
        "**Access or update your information.** If you have registered for an account with us through the Service, you may review and update certain account information by logging into the account. You can change your name in [Settings](/settings); to change your email address, contact us.",
      ),
      p(
        "**Opt-out of communications.** You may opt out of marketing-related emails, or ask us to take your email address off the waitlist, by contacting us. Please note that if you choose to opt out of marketing-related emails, you may continue to receive service-related and other non-marketing emails.",
      ),
      p(
        "**Cookies and other technologies.** Most browsers let you remove or reject cookies. To do this, follow the instructions in your browser settings. Many browsers accept cookies by default until you change your settings. If you block or delete our session cookie, you will not be able to stay signed in to the web app, and clearing a game’s site data resets the scores and settings it saved. To remove the login the `vg` CLI saved on your computer, run `vg logout`.",
      ),
      p(
        "**Do Not Track.** Some Internet browsers may be configured to send “Do Not Track” signals to the online services that you visit. We currently do not respond to “Do Not Track” signals, because the Service does not track you across other websites.",
      ),
      p(
        "**Declining to provide information.** We need to collect personal information to provide certain services. If you do not provide the information we identify as required or mandatory, we may not be able to provide those services.",
      ),
      p(
        `**Delete your content or close your account.** You can delete a game, with its files and source, from your games page at [/home](/home), and revoke an API key in [Settings](/settings). To close your account, email us at ${mail} from the email address on your account: we will delete your games, with their files and source, and then your account and its other data, including your waitlist entry.`,
      ),
    ],
    heading: H.choices,
  },
  {
    blocks: [
      p(
        "The Service may contain links to websites, mobile applications, and other online services operated by third parties. In addition, our content may be integrated into web pages or other online services that are not associated with us. These links and integrations are not an endorsement of, or representation that we are affiliated with, any third party. We do not control websites, mobile applications or online services operated by third parties, and we are not responsible for their actions. We encourage you to read the privacy policies of the other websites, mobile applications and online services you use.",
      ),
      p(
        "Games on `{slug}.vibedgames.com` are made by the people who deploy them. A game may run its own code, store data in your browser, load content from other services or collect information of its own. Apart from the example games we publish, those practices are their developers’, not ours, and this Privacy Policy does not cover them.",
      ),
      p(
        "The `vg` CLI and the tools it runs also contact third-party services directly from your computer: it checks the npm registry for a new version once a day and installs updates from it (set `VG_NO_AUTO_UPDATE=1` to turn this off); `vg new`, `vg init` and `vg update` download templates and skills from GitHub, the skills through the open-source `skills` installer; the first `vg playtest` installs its browser-automation tool from npm and downloads a browser; and `vg generate` uploads your input files to, and downloads results from, the AI model provider’s storage. Those services handle these requests under their own privacy policies.",
      ),
    ],
    heading: H.other,
  },
  {
    blocks: [
      p(
        "We employ technical, organizational and physical safeguards designed to protect the personal information we collect. However, security risk is inherent in all internet and information technologies and we cannot guarantee the security of your personal information.",
      ),
      p(
        "For example, we store passwords and API keys only as hashes, keep the sign-in cookie away from the game subdomains, and rate-limit sign-in attempts.",
      ),
    ],
    heading: H.security,
  },
  {
    blocks: [
      p(
        "We are based in the United States and may use service providers that operate in other countries. Your personal information may be transferred to the United States or other locations where privacy laws may not be as protective as those in your state, province, or country.",
      ),
      p(
        "Users in Europe should read the important information provided below about transfer of personal information outside of Europe.",
      ),
    ],
    heading: H.transfer,
  },
  {
    blocks: [
      p(
        "The Service is not intended for use by anyone under 13 years of age. If you are a parent or guardian of a child from whom you believe we have collected personal information in a manner prohibited by law, please contact us. If we learn that we have collected personal information through the Service from a child without the consent of the child’s parent or guardian as required by law, we will comply with applicable legal requirements to delete the information. We do not knowingly collect personal information from children under 13.",
      ),
    ],
    heading: H.children,
  },
  {
    blocks: [
      p(
        "We reserve the right to modify this Privacy Policy at any time. If we make material changes to this Privacy Policy, we will notify you by updating the date of this Privacy Policy and posting it on the Service or other appropriate means. Any modifications to this Privacy Policy will be effective upon our posting the modified version (or as otherwise indicated at the time of posting). In all cases, your use of the Service after the effective date of any modified Privacy Policy indicates your acknowledging that the modified Privacy Policy applies to your interactions with the Service and our business.",
      ),
      p("Whenever this Privacy Policy changes, we update the date at the top of this page."),
    ],
    heading: H.changes,
  },
  {
    blocks: [
      p(
        "If you have questions about our practices or if you would like to exercise any privacy related right that may be available to you, please contact us via one of the methods listed below.",
      ),
      ul(`**Email**: ${mail}`),
      p(
        `For general questions that involve no personal information, you can also [open an issue on GitHub](${siteConfig.issues}). Issues are public, so please do not include personal information in one.`,
      ),
    ],
    heading: H.contact,
  },
  {
    blocks: [
      p(
        "Except as otherwise provided, this section applies to residents of U.S. states to the extent they have privacy laws applicable to us that grant their residents the rights described below (collectively the “**State Privacy Laws**”).",
      ),
      p(
        "This section describes how we collect, use, and share Personal Information of residents of these states and the rights these users may have with respect to their Personal Information. Please note that not all rights listed below may be afforded to all users and that if you are not a resident of one of these states listed above, you may not be able to exercise these rights. In addition, **we may not be able to process your request if you do not provide us with sufficient detail to allow us to confirm your identity or understand and respond to it. To confirm your identity, we will ask you to send your request from, or confirm it from, the email address associated with your account (or, if you have no account, the email address you gave us, such as when you joined the waitlist).**",
      ),
      p(
        "For purposes of this section, the term “**Personal Information**” has the meaning given to “personal data”, “personal information” or other similar terms and “**Sensitive Personal Information**” has the meaning given to “sensitive personal information,” “sensitive data”, or other similar terms in the State Privacy Laws, except that in neither case does such term include information exempted from the scope of the State Privacy Laws.",
      ),
      p(
        "**Your privacy rights.** The State Privacy Laws may provide residents with some or all of the rights listed below. However, these rights are not absolute and some State Privacy Laws do not provide these rights to their residents. Therefore, we may decline your request in certain cases as permitted by law.",
      ),
      p(
        "**Information.** You can request the following information about how we have collected and used your Personal Information:",
      ),
      ul(
        "The categories of Personal Information that we have collected.",
        "The categories of sources from which we collected Personal Information.",
        "The business or commercial purpose for collecting and/or selling Personal Information.",
        "The categories of third parties with which we share Personal Information.",
        "The categories of Personal Information that we sold or disclosed for a business purpose.",
        "The categories of third parties to whom the Personal Information was sold or disclosed for a business purpose.",
      ),
      p(
        "**Access.** You can request a copy of the Personal Information that we have collected about you.",
      ),
      p("**Appeal.** You can appeal our denial of any request validly submitted."),
      p(
        "**Correction.** You can ask us to correct inaccurate Personal Information that we have collected about you.",
      ),
      p(
        "**Deletion.** You can ask us to delete the Personal Information that we have collected from you.",
      ),
      p("**Opt-out.**"),
      ul(
        "**Opt-out of certain processing for targeted advertising purposes.** We do not process your personal information for targeted advertising purposes.",
        "**Opt-out of or appeal profiling/automated decision making.** We do not use your Personal Information to engage in profiling or to perform automated decision-making that results in significant financial impacts, significant impacts on housing, education, employment, health care, or criminal justice, or similarly significant impacts.",
        "**Opt-out of other sales of personal data.** We do not sell your Personal Information within the meaning of State Privacy Laws.",
      ),
      p(
        "**Consumers under 16.** We do not have actual knowledge that we collect, sell or share the personal information of consumers under 16 years of age.",
      ),
      p(
        "**Sensitive Personal Information.** While we process certain categories of Sensitive Personal Information as described in this Privacy Policy, such as the login credentials for your account, we do not process Sensitive Personal Information for the purpose of inferring characteristics about consumers under the CCPA.",
      ),
      p(
        "**Nondiscrimination.** You are entitled to exercise the rights described above free from discrimination as prohibited by the State Privacy Laws.",
      ),
      p(
        "**Exercising your right to opt-out of the “sale” or “sharing” of your Personal Information.** We do not sell your Personal Information or “share” it for cross-context behavioral advertising, as the State Privacy Laws define those terms, so there is nothing to opt out of. If that ever changes, we will update this Privacy Policy first, offer a way to opt out, and honor Global Privacy Control (“GPC”) signals as valid opt-out requests, as required by applicable law.",
      ),
      p(
        `**Exercising other state privacy rights.** You may submit requests to exercise any of the other state privacy rights listed above via email to ${mail}.`,
      ),
      p(
        "**Verification of Identity; Authorized agents.** We may need to verify your identity in order to process your information, access, appeal, correction, or deletion requests and reserve the right to confirm your residency. To verify your identity, we may require government identification, a declaration under penalty of perjury, or other information, where permitted by law.",
      ),
      p(
        "Under some State Privacy Laws, you may enable an authorized agent to make a request on your behalf. However, we may need to verify your authorized agent’s identity and authority to act on your behalf. We may require a copy of a valid power of attorney given to your authorized agent pursuant to applicable law. If you have not provided your agent with such a power of attorney, we may ask you to take additional steps permitted by law to verify that your request is authorized, such as by providing your agent with written and signed permission to exercise your State Privacy Laws rights on your behalf, the information we request to verify your identity, and confirmation that you have given the authorized agent permission to submit the request.",
      ),
      p(
        "**Information practices.** The following describes our practices currently and during the past 12 months:",
      ),
      ul(
        "**Sources and purposes.** We collect all categories of personal information from the sources and use them for the business/commercial purposes described above in the Privacy Policy.",
        "**Retention.** The criteria for deciding how long to retain personal information is generally based on whether such period is sufficient to fulfill the purposes for which we collected it as described in this notice, including complying with our legal obligations.",
        "**Deidentification.** We do not attempt to reidentify deidentified information derived from personal information, except for the purpose of testing whether our deidentification processes comply with applicable law.",
      ),
      p(
        `**Personal information that we collect, use and disclose.** We have summarized the Personal Information we collect, the purposes for which we collect it and the third parties to whom we may disclose it by reference below to both the categories defined in the ${link(H.collect)} section of this Privacy Policy above and the categories of Personal Information specified in the CCPA (Cal. Civ. Code §1798.140). This chart describes our practices currently and during the 12 months preceding the effective date of this Privacy Policy. Information you voluntarily provide to us, such as in free-form webforms, may contain other categories of personal information not described below.`,
      ),
      table(
        [
          "Personal Information (“PI”) we collect",
          "CCPA statutory category",
          "Purposes",
          "Categories of third parties to whom we “disclose” PI for a business purpose",
          "Categories of third parties to whom we “sell” or “share” PI",
        ],
        [
          "Contact data",
          "Identifiers; California Customer Records",
          OPERATIONS,
          DISCLOSED_TO,
          "None",
        ],
        [
          "Profile data",
          "Identifiers; Sensitive personal information (account log-in credentials)",
          OPERATIONS,
          DISCLOSED_TO,
          "None",
        ],
        [
          "Communications data",
          "Identifiers; California Customer Records",
          OPERATIONS,
          DISCLOSED_TO,
          "None",
        ],
        ["Transactional data", "Commercial information", OPERATIONS, DISCLOSED_TO, "None"],
        [
          "Marketing data",
          "Identifiers",
          "Direct marketing; Compliance and protection",
          DISCLOSED_TO,
          "None",
        ],
        [
          "User-generated content and input data",
          "Audio, electronic, visual or similar information",
          OPERATIONS,
          "Service providers; Third parties designated by you; Other users and the public; Professional advisors; Authorities and others; Business transferees",
          "None",
        ],
        [
          "Device data",
          "Identifiers; Internet or other electronic network activity information",
          OPERATIONS,
          DISCLOSED_TO,
          "None",
        ],
        [
          "Online activity data",
          "Internet or other electronic network activity information",
          OPERATIONS,
          DISCLOSED_TO,
          "None",
        ],
      ),
      p(
        `Each category above may also be used for the purposes described under “Data sharing in the context of corporate events,” “To create aggregated, de-identified and/or anonymized data” and “Further uses” in ${link(H.use)}.`,
      ),
      p("**Additional information for California residents.**"),
      p(
        `**Shine the light law.** Under California’s Shine the Light law (California Civil Code Section 1798.83), California residents may ask companies with whom they have formed a business relationship primarily for personal, family or household purposes to provide the names of third parties to which they have disclosed certain personal information (as defined under the Shine the Light law) during the preceding calendar year for their own direct marketing purposes, and the categories of personal information disclosed. We do not disclose personal information to third parties for their own direct marketing purposes. You may send us requests for this information to ${mail}. In your request, you must include the statement “Shine the Light Request,” and provide your first and last name and mailing address and certify that you are a California resident. We reserve the right to require additional information to confirm your identity and California residency. Please note that we will not accept requests via telephone, mail, or facsimile, and we are not responsible for notices that are not labeled or sent properly, or that do not have complete information.`,
      ),
      p(
        `**Additional information for Nevada residents.** Nevada residents have the right to opt-out of the sale of certain personal information for monetary consideration. While we do not currently engage in such sales, if you are a Nevada resident and would like to make a request to opt out of any potential future sales, please email ${mail}.`,
      ),
      p(
        `**Contact Us.** If you have questions or concerns about our privacy policies or information practices, please contact us using the contact details set forth in the ${link(H.contact)} section above.`,
      ),
    ],
    heading: H.state,
  },
  {
    blocks: [
      p("**General**"),
      p(
        "**Where this Notice to European users applies.** The information provided in this “Notice to European users” section applies only to individuals in the United Kingdom and the European Economic Area (i.e., “Europe” as defined at the top of this Privacy Policy).",
      ),
      p(
        "**Personal information.** References to “personal information” in this Privacy Policy should be understood to include a reference to “personal data” (as defined in the GDPR) — i.e., information about individuals from which they are either directly identified or can be identified.",
      ),
      p(
        `**Controller.** ${operator}, who provides Vibedgames, is the controller in respect of the processing of your personal information covered by this Privacy Policy for purposes of European data protection legislation (i.e., the EU GDPR and the so-called ‘UK GDPR’ (as and where applicable, the “**GDPR**”)). See the ${link(H.contact, `‘${H.contact}’`)} section above for our contact details.`,
      ),
      p("**Our legal bases for processing**"),
      p(
        "In respect of each of the purposes for which we use your personal information, the GDPR requires us to ensure that we have a “legal basis” for that use.",
      ),
      p(
        "Our legal bases for processing your personal information described in this Privacy Policy are listed below.",
      ),
      ul(
        "Where we need to perform a contract, we are about to enter into or have entered into with you (“**Contractual Necessity**”).",
        "Where it is necessary for our legitimate interests and your interests and fundamental rights do not override those interests (“**Legitimate Interests**”). More detail about the specific legitimate interests pursued in respect of each Purpose we use your personal information for is set out in the table below.",
        "Where we need to comply with a legal or regulatory obligation (“**Compliance with Law**”).",
        "Where we have your specific consent to carry out the processing for the Purpose in question (“**Consent**”).",
      ),
      p(
        `We have set out below, in a table format, the legal bases we rely on in respect of the relevant Purposes for which we use your personal information — for more information on these Purposes and the data types involved, see ${link(H.use, `‘${H.use}’`)}.`,
      ),
      table(
        ["Purpose", "Categories of personal information involved", "Legal basis"],
        [
          "Service delivery and operations",
          "Contact data; Profile data; Communications data; Transactional data; User-generated content and input data; Device data; Online activity data",
          "Contractual Necessity.",
        ],
        [
          "Security",
          "Contact data; Profile data; Device data; Online activity data",
          "Compliance with Law. Legitimate Interests. We have a legitimate interest in ensuring the ongoing security and proper operation of our Service and associated IT services, systems, and networks.",
        ],
        [
          "Direct marketing",
          "Contact data; Marketing data",
          "Legitimate Interests. We have a legitimate interest in promoting our operations and goals and sending marketing communications for that purpose. Consent, in circumstances or in jurisdictions where consent is required under applicable data protection laws to the sending of any given marketing communications.",
        ],
        [
          "Compliance and protection",
          "Contact data; Profile data; Communications data; Transactional data; User-generated content and input data; Device data; Online activity data",
          "Compliance with Law. Legitimate Interests. Where Compliance with Law is not applicable, we and any relevant third parties have a legitimate interest in participating in, supporting, and following legal process and requests, including through co-operation with authorities. We and any relevant third parties may also have a legitimate interest of ensuring the protection, maintenance, and enforcement of our and their rights, property, and/or safety.",
        ],
        [
          "Data sharing in the context of corporate events",
          "Any and all data types relevant in the circumstances",
          "Legitimate Interests. We and any relevant third parties have a legitimate interest in providing information to relevant third parties who are involved in an actual or prospective corporate event (including to enable them to investigate — and, where relevant, to continue to operate — all or relevant part(s) of our operations). However, we would always look to take steps to minimize the amount and sensitivity of any personal information shared in these contexts where possible and appropriate.",
        ],
        [
          "To create aggregated, de-identified and/or anonymized data",
          "Any and all data types relevant in the circumstances",
          "Legitimate Interests. We have legitimate interest, and believe it is also in your interests, that we are able to take steps to ensure that our Services operate as intended.",
        ],
        [
          "Further uses",
          "Any and all data types relevant in the circumstances",
          "The original legal basis relied upon, if the relevant further use is compatible with the initial purpose for which the Personal Information was collected. Consent, if the relevant further use is not compatible with the initial purpose for which the personal information was collected.",
        ],
      ),
      p("**Retention**"),
      p(
        "We retain personal information for as long as necessary to fulfil the purposes for which we collected it, including for the purposes of satisfying any legal, accounting, or reporting requirements, establishing or defending legal claims, or for Compliance and protection purposes.",
      ),
      p(
        "To determine the appropriate retention period for personal information, we consider the amount, nature, and sensitivity of the personal information, the potential risk of harm from unauthorized use or disclosure of your personal information, the purposes for which we process your personal information and whether we can achieve those purposes through other means, and the applicable legal requirements.",
      ),
      p(
        "When we no longer require the personal information we have collected about you, we will either delete or anonymize it or, if this is not possible (for example, because your personal information has been stored in backup archives), then we will securely store your personal information and isolate it from any further processing until deletion is possible. If we anonymize your personal information (so that it can no longer be associated with you), we may use this information indefinitely without further notice to you.",
      ),
      p("**Other info**"),
      p(
        "**No sensitive personal information.** The Service does not ask for sensitive personal information (e.g., social security numbers, information related to racial or ethnic origin, political opinions, religion or other beliefs, health, biometrics or genetic characteristics, criminal background or trade union membership). If you choose to include it in content you create, such as a game, a prompt or a file you upload, you consent to our processing it in accordance with this Privacy Policy solely to provide the Service to you; if you do not consent, do not include it.",
      ),
      p(
        "**No Automated Decision-Making and Profiling.** As part of the Service, we do not engage in automated decision-making and/or profiling, which produces legal or similarly significant effects.",
      ),
      p("**Your rights**"),
      p(
        "**General.** European data protection laws give you certain rights regarding your personal information. If you are located in Europe, you may ask us to take the following actions in relation to your personal information that we hold:",
      ),
      ul(
        "**Access.** Provide you with information about our processing of your personal information and give you access to your personal information.",
        "**Correct.** Update or correct inaccuracies in your personal information.",
        "**Delete.** Delete your personal information where there is no good reason for us continuing to process it — you also have the right to ask us to delete or remove your personal information where you have exercised your right to object to processing (see below).",
        "**Transfer.** Transfer a machine-readable copy of your personal information to you or a third party of your choice.",
        "**Restrict.** Restrict the processing of your personal information, for example if you want us to establish its accuracy or the reason for processing it.",
        "**Object.** Object to our processing of your personal information where we are relying on Legitimate Interests — you also have the right to object where we are processing your personal information for direct marketing purposes.",
        "**Withdraw Consent.** When we use your personal information based on your consent, you have the right to withdraw that consent at any time.",
      ),
      p(
        `**Exercising These Rights.** You may submit these requests by email to ${mail}. We may request specific information from you to help us confirm your identity and process your request. Whether or not we are required to fulfill any request you make will depend on a number of factors (e.g., why and how we are processing your personal information), if we reject any request you may make (whether in whole or in part) we will let you know our grounds for doing so at the time, subject to any legal restrictions.`,
      ),
      p(
        "**Your Right to Lodge a Complaint with your Supervisory Authority.** In addition to your rights outlined above, if you are not satisfied with our response to a request you make, or how we process your personal information, you can make a complaint to the data protection regulator in your habitual place of residence.",
      ),
      ul(
        "For users in the European Economic Area — the contact information for the data protection regulator in your place of residence can be found here: [https://www.edpb.europa.eu/about-edpb/our-members_en](https://www.edpb.europa.eu/about-edpb/our-members_en)",
        "For users in the UK — the contact information for the UK data protection regulator is below: The Information Commissioner’s Office, Water Lane, Wycliffe House, Wilmslow – Cheshire SK9 5AF, Tel. +44 303 123 1113, Website: [https://ico.org.uk/make-a-complaint/](https://ico.org.uk/make-a-complaint/)",
      ),
      p("**Data Processing outside Europe**"),
      p(
        "We are based in the U.S. and many of our service providers, advisers or other recipients of data are also based in the U.S. This means that, if you use the Service, your personal information will necessarily be accessed and processed in the U.S. It may also be provided to recipients in other countries outside Europe.",
      ),
      p(
        "It is important to note that the U.S. is not the subject of a general ‘adequacy decision’ under the GDPR – the EU-U.S. Data Privacy Framework and its UK Extension cover only organizations certified under them, and we are not certified. Basically, this means that the U.S. legal regime is not considered by relevant European bodies to provide an adequate level of protection for personal information transferred to us, which is equivalent to that provided by relevant European laws.",
      ),
      p(
        "Where we share your personal information with third parties who are based outside Europe, we try to ensure a similar degree of protection is afforded to it by making sure one of the following mechanisms is implemented:",
      ),
      ul(
        "**Transfers to territories with an adequacy decision.** We may transfer your personal information to countries or territories whose laws have been deemed to provide an adequate level of protection for personal information by the European Commission or UK Government (as and where applicable) (from time to time).",
        "**Transfers to territories without an adequacy decision.** We may transfer your personal information to countries or territories whose laws have not been deemed to provide such an adequate level of protection (e.g., the U.S., see above). However, in these cases: we may use specific appropriate safeguards, which are designed to give personal information effectively the same protection it has in Europe — for example, standard-form contracts approved by relevant authorities for this purpose; or in limited circumstances, we may rely on an exception, or ‘derogation’, which permits us to transfer your personal information to such country despite the absence of an ‘adequacy decision’ or ‘appropriate safeguards’ — for example, reliance on your explicit consent to that transfer.",
      ),
      p(
        `You may contact us if you want further information on the specific mechanism used by us when transferring your personal information out of Europe. You may have the right to receive a copy of the appropriate safeguards under which your personal information is transferred by contacting us at ${mail}.`,
      ),
    ],
    heading: H.europe,
  },
];

export const privacyDoc: Doc = {
  description:
    "How Vibedgames collects, uses and shares personal information across vibedgames.com, the games it hosts, the vg CLI and the agent skills, and the choices and rights you have, including under U.S. state privacy laws and the GDPR.",
  endnote: [
    p(
      "This template was prepared and made publicly available by General Legal, PC (“General Legal”). It is provided for general reference purposes only and does not constitute, and should not be construed as, legal advice, or an endorsement or review of any particular transaction in which it is used. Use of this template does not create an attorney-client relationship with General Legal. General Legal has not reviewed, and takes no position on, any modifications made to this document or the deal terms it is used to document.",
    ),
  ],
  lead: [
    p("Effective as of October 3, 2026."),
    p(
      `To view previous versions of this Privacy Policy, see its [history on GitHub](${siteConfig.repository}/commits/main/apps/web/src/content/privacy.ts).`,
    ),
    p(
      `**California Notice at Collection/State Privacy Rights Notice**: See the ${link(H.state)} section below for important information about your rights under applicable state privacy laws.`,
    ),
    p(
      `${operator} (“**Vibedgames**,” “**we**,” “**us**” or “**our**”) provides Vibedgames, an agent-native platform for building, hosting and shipping browser games. This Privacy Policy describes how Vibedgames processes personal information that we collect through our digital or online properties or services that link to this Privacy Policy (including, as applicable, our website at vibedgames.com, the games we host on its subdomains, our multiplayer servers, the \`vg\` command-line tool and the vibedgames agent skills and plugin) and the other activities described in this Privacy Policy (collectively, the “**Service**”).`,
    ),
    p(
      `**Notice to European users**: Please see the ${link(H.europe)} section below for additional information for individuals located in the European Economic Area or United Kingdom (which we refer to as “**Europe**”, and “**European**” should be understood accordingly).`,
    ),
    p(
      `You can download a printable copy of this Privacy Policy as plain text by requesting ${siteConfig.url}/privacy with the header \`Accept: text/markdown\`.`,
    ),
    p("**Index**"),
    ul(...sections.map((section) => link(section.heading))),
  ],
  path: "/privacy",
  sections,
  title: "Privacy Policy",
};
