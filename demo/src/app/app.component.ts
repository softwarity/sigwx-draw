import { Component, CUSTOM_ELEMENTS_SCHEMA } from "@angular/core";
import { MatIconModule } from "@angular/material/icon";
import { ShowcaseComponent } from "./showcase/showcase.component";

@Component({
  selector: "app-root",
  imports: [MatIconModule, ShowcaseComponent],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.scss",
})
export class AppComponent {}
