# Tími NOW experience specification

The MVP contains three connected surfaces:

1. **Public website** (`#home`) — explains live veterinary intake, emergency boundaries, and clinic participation.
2. **Pet-owner PWA** (`#find`, `#results`, `#tracker`, `#pets`) — captures a concern, compares current capacity, requests acceptance, and tracks the arrival.
3. **Clinic console** (`#clinic`) — publishes current load, reports stable-patient wait ranges, and accepts or declines immediate requests.

## Core owner flow

`Landing → pet and concern → location → live capacity → request acceptance → arrival window → en route → arrived → triaged → seen`

This is deliberately not a scheduling flow. Customers never select a future appointment time. The hospital accepts a short arrival window for a specific pet and concern.

## Capacity presentation

Every result exposes:

- Available, limited, confirm first, critical only, diverting, closed, or unverified
- Stable-patient wait range rather than an exact promise
- Source: hospital, integration, Tími request, community observation, or prediction
- High, medium, or low confidence
- Human-readable freshness timestamp
- Emergency capability, species support, distance, and phone number

Expired availability is displayed as unverified and cannot masquerade as live capacity.

## Interaction and transition notes

- View Transitions are used when available and disabled for reduced-motion users.
- Availability remains network-only; the service worker never caches API responses.
- The intake tracker polls while a request is pending and stops when the user leaves the screen.
- Clinic status refreshes every 15 seconds and can be manually refreshed.
- Dialogs support outside-click closure and preserve keyboard behavior provided by the native dialog element.
- Form controls have labels, validation, clear focus styles, adequate touch targets, and status announcements.
- Location permission is optional; the demonstration area remains usable when denied.

## Emergency behavior

Checking a red flag or describing a recognized warning elevates the API request to emergency. A non-emergency facility cannot accept that request through the API. The interface directs customers toward an appropriate emergency-capable hospital and states that hospital staff perform triage.

The shortest stable-patient wait is never presented as the only routing factor for a possible emergency.

## Brand intent

- **Royal blue** — regal, confident Tími master brand
- **Coral** — humane urgency and NOW actions
- **Marigold** — warmth, annotation, and playful energy
- **Ink and cream** — premium foundation
- The wordmark remains crisp and premium; hand-drawn energy appears in illustrations, uneven shapes, borders, shadows, and restrained motion.

## Clinic operational burden

The clinic can publish a useful report in one interaction:

- Intake status
- Stable-patient wait range
- Additional capacity count
- Critical-patient acceptance
- Expiration time
- Optional public note

The report expires automatically. Clinic staff do not manage appointment slots or duplicate a calendar.
