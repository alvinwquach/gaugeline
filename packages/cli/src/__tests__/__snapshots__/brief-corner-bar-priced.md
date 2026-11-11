# Work order: The Corner Bar

Checked ORIGIN/ at 2026-11-10T09:00:00.000Z.

## What is worth paying to fix

6 items are worth paying to fix, 8 points in all.

| #   | Item                                            | Size   | Points |
| --- | ----------------------------------------------- | ------ | -----: |
| 1   | This page tells Google to show a different page | Small  |      1 |
| 2   | This page isn't set up for phone screens        | Small  |      1 |
| 3   | Some buttons open an email instead of a form    | Medium |      3 |
| 4   | Some images have no alt attribute               | Small  |      1 |
| 5   | Images use older, heavier file formats          | Small  |      1 |
| 6   | Shared links have no picture                    | Small  |      1 |

At 1.5 hours per point, that's roughly 10–16 hours (about $1,056–$1,716 at $110/hour).

Small is 1 point, Medium 3 and Large 8. Points say how big a fix is. Whoever quotes the work turns them into time and money, because the same fix is minutes in a shared component and an afternoon when it is hardcoded in twelve places, and each item says what changes its estimate.

## 1. This page tells Google to show a different page

**Size:** Small (1 point). **Priority:** Fix this first.

**What is wrong:** The page's canonical tag names a different address as the real one.

**Why it matters:** Search engines treat the page as a copy, so it may never appear in results.

**What done looks like:** Each page's canonical tag names its own address.

**Evidence:**

- \<link rel="canonical" href="ORIGIN/menu"\> on ORIGIN/ \(differs by path\)

**What changes the estimate:** A canonical that comes from one shared SEO component is a single edit. Ones set by hand in the CMS are one edit per page.

## 2. This page isn't set up for phone screens

**Size:** Small (1 point). **Priority:** Fix soon.

**What is wrong:** The page has no viewport meta tag, so phones show it zoomed out as if on a desktop screen.

**Why it matters:** Visitors have to pinch and zoom to read anything, and Google treats the page as not mobile-friendly.

**What done looks like:** The page head has a viewport meta tag.

**Evidence:**

- no \<meta name="viewport"\> on ORIGIN/

**What changes the estimate:** A template shared by every page is one edit. Pages built with different templates are one each.

## 3. Some buttons open an email instead of a form

**Size:** Medium (3 points). **Priority:** Fix soon.

**What is wrong:** A contact button \("Talk to an expert", "Get a quote"\) opens one person's email program instead of a form.

**Why it matters:** The enquiry skips your CRM: it lands in one inbox with no campaign details, nobody else sees it, and visitors without an email program set up can't send it at all.

**What done looks like:** Each button opens a form or booking page whose enquiry reaches the CRM.

**Evidence:**

- Opens an email instead of a form: "Book a table" \(mailto:ADDRESS\). (ORIGIN/)

**What changes the estimate:** A form and its CRM connection are built first if there is none, then each button is repointed.

## 4. Some images have no alt attribute

**Size:** Small (1 point). **Priority:** Worth knowing.

**What is wrong:** Some images have no alt attribute at all, not even an empty one.

**Why it matters:** Without alt, screen readers read the file name aloud. An empty alt="" tells them to skip a decorative image; a missing one does not.

**What done looks like:** Every img has an alt attribute: a description, or alt="" for decoration.

**Evidence:**

- 1 image has no alt: /patio.png (ORIGIN/)

**What changes the estimate:** Images inside CMS content are edited one by one.

## 5. Images use older, heavier file formats

**Size:** Small (1 point). **Priority:** Worth knowing.

**What is wrong:** Images are served as JPEG, PNG or GIF with no WebP or AVIF version offered.

**Why it matters:** WebP and AVIF are usually a quarter to a half smaller for the same picture, so the page loads faster.

**What done looks like:** Images are offered as WebP or AVIF through a picture element, srcset or the image component.

**Evidence:**

- 2 of 2 sampled images are JPEG, PNG or GIF only: /taps.png, /patio.png (ORIGIN/taps.png)

**What changes the estimate:** A site with no image pipeline needs one set up first.

## 6. Shared links have no picture

**Size:** Small (1 point). **Priority:** Worth knowing.

**What is wrong:** The page has no og:image tag.

**Why it matters:** When the page is shared in a chat or a social post, it shows as a plain link with no picture, which fewer people click.

**What done looks like:** The page has an og:image with a full address, about 1200 by 630 pixels.

**Evidence:**

- no og:image on ORIGIN/

**What changes the estimate:** Making the pictures is the cost if none exist.
