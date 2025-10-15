# Vibedgames

Vibedgames is an open source Lovable for multiplayer web games.

## Stack

- [Next.js](https://nextjs.org)
- [Expo](https://expo.dev)
- [Tailwind CSS](https://tailwindcss.com)
- [TRPC](https://trpc.io)
- [Drizzle](https://orm.drizzle.team)
- [Turso](https://turso.tech)

## Running Locally

1. Install dependencies using pnpm:

```sh
pnpm install
```

1. Copy `.env.example` to `.env.local` and update the variables.

```sh
cp .env.example .env.local
```

1. Start your local db:

```sh
pnpm db:start
```

1. Start the development server:

```sh
pnpm dev
```

## License

Licensed under the [MIT license](https://github.com/kyh/vibedgames/blob/main/LICENSE).
