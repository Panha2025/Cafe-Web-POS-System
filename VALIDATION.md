# Verification record

Verified in `C:\Cafe-POS` on September 15, 2026 with Node.js 24, PostgreSQL 18.4, and headless Google Chrome.

## Results

| Check                                                                | Result                                                                 |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Dependency installation                                              | Completed; npm lockfile included                                       |
| Dependency audit after image-processor update                        | Zero known vulnerabilities reported at install                         |
| PostgreSQL startup and persistence                                   | Passed; existing data recovered after environment restart              |
| Database encoding                                                    | UTF8                                                                   |
| Frontend production build                                            | Passed                                                                 |
| API integration suite                                                | 17 checks passed                                                       |
| Chrome workflow suite                                                | 4 workflows passed                                                     |
| Built frontend served by Express                                     | Passed                                                                 |
| Browser console/runtime errors in tested main workflow and built app | None                                                                   |
| Database unavailable                                                 | Friendly HTTP 503 response verified                                    |
| Receipt printing                                                     | Browser print invocation, print stylesheet, and PDF rendering verified |
| Responsive POS                                                       | Desktop and 390-pixel mobile viewport verified                         |

## Requested final workflow

The browser signed in as Admin, created **Test Latte** with a photo and price **$3.00**, opened the POS, clicked it twice, and verified quantity **2** and total **$6.00**. Increasing and decreasing quantity also worked.

Cash received of **$10.00** produced **$4.00** change. Confirming payment generated a saved receipt and order. The order was found in Order History, and the sales report's revenue and order count increased by the expected amounts.

The browser then edited Test Latte to **$4.00**, uploaded another photo, and verified the updated price and image on the POS. The product remains available at $4.00; the historical order retains its original $3.00 unit price.

## Other verified behavior

- Incorrect login, anonymous access, and cashier attempts to access admin APIs are rejected.
- Product creation, editing, deletion, availability, price validation, and photo validation work.
- Invalid image content, unsupported image types, and oversized uploads are rejected.
- Empty orders, invalid quantities, insufficient cash, invalid discounts, and stale prices/totals are rejected.
- Tax is calculated after discounts, using integer-cent arithmetic.
- Cash, manually confirmed KHQR, and manually confirmed external card payments save correctly.
- Settings form uploads logo/KHQR images and applies café details and tax to new receipts.
- A missing KHQR image prevents KHQR confirmation.
- Simultaneous checkout retries and a simulated lost response return the original order without creating duplicate sales.
- Order filters, receipt details, sales totals, best sellers, and payment summaries read PostgreSQL.
- Cashier navigation, menu search, category filtering, item removal, clearing the cart, and logout work.

## Test data and limits

Browser test sales remain in the development database as demonstration records. API tests remove their own test orders/product and restore settings. The settings browser test also restores the original café settings and removes its temporary KHQR setting; the owner still needs to upload the café's real KHQR image.

No real money was transferred. KHQR upload/display and manual confirmation were tested using a temporary image, without an ABA integration. Card confirmation was tested without a physical card terminal. Printing was tested through browser/PDF output, without a physical receipt printer. The compiled app was tested locally over HTTP; HTTPS hosting has not been deployed.

## Repeat the checks

With `npm run db:local` and `npm run dev` running, execute these sequentially:

```powershell
npm test
npm run test:e2e
npm run build
npm run test:build
npm run format:check
```

Chrome must be installed, or set `PLAYWRIGHT_CHANNEL=msedge` to use Microsoft Edge. Browser tests generate `playwright-report/index.html` and screenshots in `test-results/evidence/`. Each browser-suite run replaces its previous test artifacts.
