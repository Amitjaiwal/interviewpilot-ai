/** Built-in practice questions for Java and full-stack interviews. */

export type Level = 'basic' | 'intermediate' | 'advanced';

export interface BankQuestion {
  q: string;
  level: Level;
}

export interface BankCategory {
  id: string;
  label: string;
  questions: BankQuestion[];
}

const b = (q: string): BankQuestion => ({ q, level: 'basic' });
const i = (q: string): BankQuestion => ({ q, level: 'intermediate' });
const a = (q: string): BankQuestion => ({ q, level: 'advanced' });

export const QUESTION_BANK: BankCategory[] = [
  {
    id: 'core-java',
    label: 'Core Java',
    questions: [
      b('What is the difference between JDK, JRE and JVM?'),
      b('Explain the difference between == and equals() in Java.'),
      b('Why must you override hashCode() when you override equals()?'),
      b('What is the difference between String, StringBuilder and StringBuffer?'),
      b('What are checked and unchecked exceptions? Give examples of each.'),
      i('Explain the difference between an abstract class and an interface in modern Java.'),
      i('What does the final keyword mean on a variable, a method and a class?'),
      i('How do you create an immutable class in Java?'),
      i('What is the difference between method overloading and overriding?'),
      i('Explain try-with-resources and how AutoCloseable works.'),
      a('How do generics work with type erasure, and what limitations does erasure cause?'),
      a('Explain the PECS rule (producer extends, consumer super) with an example.'),
    ],
  },
  {
    id: 'collections',
    label: 'Collections',
    questions: [
      b('What is the difference between ArrayList and LinkedList? When would you use each?'),
      b('What is the difference between a List, a Set and a Map?'),
      i('How does HashMap work internally? What happens on a hash collision?'),
      i('What changed in HashMap in Java 8 to handle many collisions in one bucket?'),
      i('What is the difference between HashMap, LinkedHashMap and TreeMap?'),
      i('What is the difference between fail-fast and fail-safe iterators?'),
      i('Compare Comparable and Comparator.'),
      a('How does ConcurrentHashMap achieve thread safety, and how does it differ from Collections.synchronizedMap?'),
      a('How would you implement an LRU cache in Java?'),
      a('Why is it dangerous to use a mutable object as a HashMap key?'),
    ],
  },
  {
    id: 'concurrency',
    label: 'Concurrency',
    questions: [
      b('What is the difference between a process and a thread?'),
      b('What are the ways to create a thread in Java?'),
      i('What does the volatile keyword guarantee, and what does it not guarantee?'),
      i('Explain synchronized blocks versus ReentrantLock.'),
      i('What is a deadlock? How do you prevent and detect one?'),
      i('How do ExecutorService thread pools work, and how do you choose a pool size?'),
      i('What is the difference between Runnable, Callable and Future?'),
      a('Explain CompletableFuture and how you would combine several asynchronous calls.'),
      a('What is the Java memory model and the happens-before relationship?'),
      a('What are virtual threads in Java 21 and when should you use them?'),
      a('How do atomic classes and compare-and-swap work?'),
    ],
  },
  {
    id: 'jvm',
    label: 'JVM & Memory',
    questions: [
      b('What is the difference between stack and heap memory?'),
      i('How does garbage collection work in the JVM? Explain generations.'),
      i('Compare the G1, ZGC and Parallel garbage collectors.'),
      i('What causes an OutOfMemoryError and how do you investigate one?'),
      i('Explain class loading and the parent delegation model.'),
      a('How would you diagnose high CPU usage in a running Java service?'),
      a('What is JIT compilation and how does it affect performance?'),
      a('What are memory leaks in Java and how can they happen despite garbage collection?'),
    ],
  },
  {
    id: 'modern-java',
    label: 'Java 8-21 features',
    questions: [
      b('What is a lambda expression and a functional interface?'),
      b('What is Optional and how should it be used?'),
      i('Explain the Stream API. What is the difference between intermediate and terminal operations?'),
      i('What is the difference between map and flatMap in streams?'),
      i('How do parallel streams work and when are they a bad idea?'),
      i('What are records in Java and when would you use them?'),
      i('What are sealed classes and how do they work with pattern matching?'),
      a('Explain pattern matching for switch in Java 21 with an example.'),
    ],
  },
  {
    id: 'spring',
    label: 'Spring Boot',
    questions: [
      b('What is dependency injection and how does Spring implement it?'),
      b('What is the difference between @Component, @Service, @Repository and @Controller?'),
      i('How does Spring Boot auto-configuration work?'),
      i('Explain bean scopes in Spring.'),
      i('What is the Spring bean lifecycle?'),
      i('How do you handle exceptions globally in a Spring REST API?'),
      i('How do Spring profiles and externalized configuration work?'),
      a('How does @Transactional work internally, and why does self-invocation bypass it?'),
      a('Explain transaction propagation levels with examples.'),
      a('How does Spring Security authenticate a request using JWT?'),
      a('How would you make a Spring Boot service observable (logs, metrics, traces)?'),
    ],
  },
  {
    id: 'jpa',
    label: 'JPA & Hibernate',
    questions: [
      b('What is the difference between JPA and Hibernate?'),
      i('What is the N+1 select problem and how do you fix it?'),
      i('Explain lazy versus eager loading. What is a LazyInitializationException?'),
      i('What are the entity states in JPA (transient, managed, detached, removed)?'),
      i('What is the difference between save, persist and merge?'),
      a('How do optimistic and pessimistic locking work in JPA?'),
      a('How do first-level and second-level caches work in Hibernate?'),
    ],
  },
  {
    id: 'microservices',
    label: 'Microservices',
    questions: [
      b('What are microservices and how do they differ from a monolith?'),
      i('How do services discover and communicate with each other?'),
      i('What is an API gateway and why use one?'),
      i('Explain the circuit breaker pattern.'),
      i('How do you handle configuration and secrets across many services?'),
      a('How do you keep data consistent across services? Explain the saga pattern.'),
      a('What is the outbox pattern and what problem does it solve?'),
      a('How would you trace a request across ten microservices?'),
      a('When would you choose Kafka over a REST call between services?'),
    ],
  },
  {
    id: 'rest',
    label: 'REST & HTTP',
    questions: [
      b('What are the main HTTP methods and which ones are idempotent?'),
      b('Explain common HTTP status codes: 200, 201, 204, 400, 401, 403, 404, 409, 500.'),
      i('How would you design pagination, filtering and sorting for a REST API?'),
      i('How do you version a REST API?'),
      i('What is CORS and why does the browser enforce it?'),
      a('How would you make a payment endpoint idempotent?'),
      a('How do you implement rate limiting for a public API?'),
    ],
  },
  {
    id: 'sql',
    label: 'SQL & Databases',
    questions: [
      b('What is the difference between INNER, LEFT, RIGHT and FULL joins?'),
      b('What is the difference between WHERE and HAVING?'),
      i('How do indexes work, and when can an index hurt performance?'),
      i('Explain ACID properties.'),
      i('What are transaction isolation levels and which anomalies does each prevent?'),
      i('Write a query to find the second highest salary in each department.'),
      i('What is database normalization? When would you denormalize?'),
      a('How would you investigate a slow query in production?'),
      a('Compare SQL and NoSQL databases. When would you choose each?'),
      a('How do you scale a relational database: replication, partitioning, sharding?'),
    ],
  },
  {
    id: 'angular',
    label: 'Angular',
    questions: [
      b('What are components, modules and standalone components in Angular?'),
      b('Explain the different kinds of data binding in Angular.'),
      i('How does change detection work, and what does OnPush change?'),
      i('What are signals in Angular and how do they compare with RxJS observables?'),
      i('Explain dependency injection hierarchies in Angular.'),
      i('What is the difference between switchMap, mergeMap, concatMap and exhaustMap?'),
      a('How would you improve the performance of a slow Angular application?'),
      a('How do you structure state management in a large Angular app?'),
    ],
  },
  {
    id: 'javascript',
    label: 'JavaScript & TypeScript',
    questions: [
      b('What is the difference between var, let and const?'),
      b('Explain == versus === in JavaScript.'),
      i('Explain closures with an example.'),
      i('How does the event loop work? What are microtasks and macrotasks?'),
      i('Explain promises and async/await, including error handling.'),
      i('What are TypeScript generics and utility types such as Partial and Pick?'),
      a('Explain prototypal inheritance and how classes map onto it.'),
      a('What is the difference between interface and type in TypeScript?'),
    ],
  },
  {
    id: 'system-design',
    label: 'System design',
    questions: [
      i('Design a URL shortener.'),
      i('Design a rate limiter.'),
      i('How would you design caching for a read-heavy service? Discuss invalidation.'),
      a('Design a notification system that sends email, SMS and push notifications.'),
      a('Design a chat application like WhatsApp.'),
      a('Design an e-commerce checkout that never charges a customer twice.'),
      a('Explain the CAP theorem with a practical example.'),
      a('Design a news feed for a social network.'),
    ],
  },
  {
    id: 'dsa',
    label: 'Data structures & algorithms',
    questions: [
      b('Reverse a linked list. What is the complexity?'),
      b('Check whether a string is a palindrome, ignoring non-alphanumeric characters.'),
      i('Find two numbers in an array that add up to a target (Two Sum).'),
      i('Find the length of the longest substring without repeating characters.'),
      i('Detect a cycle in a linked list.'),
      i('Merge overlapping intervals.'),
      i('Implement binary search and explain its edge cases.'),
      i('Validate whether a binary tree is a binary search tree.'),
      a('Find the k most frequent elements in an array.'),
      a('Implement an LRU cache with O(1) get and put.'),
      a('Find the shortest path in a weighted graph. Which algorithm and why?'),
      a('Serialize and deserialize a binary tree.'),
    ],
  },
  {
    id: 'behavioral',
    label: 'Behavioral',
    questions: [
      b('Tell me about yourself.'),
      b('Why do you want to join this company?'),
      i('Tell me about a challenging bug you fixed.'),
      i('Describe a time you disagreed with a teammate. How did you resolve it?'),
      i('Tell me about a project you are most proud of.'),
      i('Describe a time you missed a deadline. What did you learn?'),
      a('Tell me about a technical decision you made that you would make differently now.'),
      a('Describe a time you improved the performance or reliability of a system.'),
    ],
  },
];

/** Pick `count` random questions from a category without repeats. */
export function sampleQuestions(category: BankCategory, count: number, level: Level | 'all' = 'all'): string[] {
  const pool = category.questions.filter((q) => level === 'all' || q.level === level).map((q) => q.q);
  for (let n = pool.length - 1; n > 0; n--) {
    const k = Math.floor(Math.random() * (n + 1));
    [pool[n], pool[k]] = [pool[k], pool[n]];
  }
  return pool.slice(0, count);
}

/** Extract questions from a model's numbered list output. */
export function parseQuestionList(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .map((l) => /^(?:\d+[.)]|[-*])\s+(.*)$/.exec(l)?.[1]?.replace(/\*\*/g, '').trim() ?? '')
    .filter((q) => q.length > 8);
}

/** Read "Score: N/10" from an evaluation. */
export function parseScore(text: string): number | null {
  const m = /score[^0-9]{0,12}(\d{1,2}(?:\.\d)?)\s*\/\s*10/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 10 ? n : null;
}
